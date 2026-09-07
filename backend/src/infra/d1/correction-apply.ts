import { sql, type SQL } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';

/**
 * Applying an attendance correction on D1.
 *
 * The problem this exists to solve: on Postgres the whole thing runs inside one
 * interactive transaction — read the request, work out which session it means,
 * write the session, mark the request applied — and any throw rolls all of it
 * back. D1 has no interactive transaction. It is auto-commit, and its batch()
 * takes statements decided up front, so there is no way to read a row, branch
 * on it, and keep the earlier writes provisional.
 *
 * Done naively that gives you the failure that matters: a session updated with
 * new times while the request still reads PENDING, or a request marked APPLIED
 * against a session that was never touched. Either one is a correction that
 * half happened, on attendance data somebody is paid from.
 *
 * The shape here avoids it in two layers.
 *
 * First, all reads happen before any write, and every decision — which session,
 * what the new values are, whether this is even legal — is made in memory. By
 * the time anything is written there are no branches left.
 *
 * Second, every write is guarded by the same predicate: the request is still
 * PENDING. They go to D1 as one batch, which is a SQL transaction and rolls the
 * lot back if any statement errors. If the request is no longer pending — a
 * second reviewer got there first — every statement matches zero rows and the
 * batch is a no-op. So the two ways this can fail, an error midway and a race,
 * both land on "nothing changed" rather than on half of it.
 *
 * The guard is not decoration: it is what makes the read-then-write gap safe
 * without a transaction to hold it closed.
 *
 * The statements are built with Drizzle and handed to D1's own batch() rather
 * than to Drizzle's. Drizzle's wrapper did not accept raw sql templates in this
 * version — it fails with "Cannot read properties of undefined (reading
 * 'bind')" — and the atomicity being relied on belongs to D1 anyway. Rendering
 * the SQL through Drizzle keeps the parameter binding, so nothing is
 * interpolated into a statement by hand.
 */

/** Renders a Drizzle `sql` template into a statement D1 can prepare. */
const dialect = new SQLiteAsyncDialect();
function prepare(db: D1Database, query: SQL): D1PreparedStatement {
  const { sql: text, params } = dialect.sqlToQuery(query);
  return db.prepare(text).bind(...(params as unknown[]));
}

export interface SessionPatch {
  loginAt?: Date;
  logoutAt?: Date;
  siteId?: string;
  shiftId?: string;
  workedMinutes?: number | null;
  state?: 'OPEN' | 'CLOSED';
}

export interface ApplyPlan {
  requestId: string;
  reviewedBy: string;
  reviewNotes?: string | null;
  autoApplied: boolean;
  /** The session to update, or the one to create when none exists. */
  session:
    | { kind: 'update'; id: string; patch: SessionPatch }
    | { kind: 'create'; row: NewSessionRow };
}

export interface NewSessionRow {
  id: string;
  organizationId: string;
  workerId: string;
  siteId: string;
  shiftId: string | null;
  workDate: string;
  loginAt: Date;
  logoutAt: Date | null;
  state: 'OPEN' | 'CLOSED';
  workedMinutes: number | null;
}

/** The predicate every write hangs off. Written once so it cannot drift. */
const stillPending = (requestId: string) =>
  sql`EXISTS (SELECT 1 FROM correction_requests WHERE id = ${requestId} AND status = 'PENDING')`;

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

/**
 * Applies a plan. Returns whether it took effect.
 *
 * False means the request was no longer pending — not an error, and not a
 * partial write. The caller reports it as "somebody already reviewed this".
 */
export async function applyCorrectionPlan(
  db: D1Database,
  plan: ApplyPlan,
  now: Date = new Date(),
): Promise<boolean> {
  const guard = stillPending(plan.requestId);
  const statements: D1PreparedStatement[] = [];

  if (plan.session.kind === 'update') {
    const p = plan.session.patch;
    // Each column is written only when the correction proposed it, so a
    // logout-only correction cannot blank a login time by writing null over it.
    const sets = [
      p.loginAt !== undefined ? sql`login_at = ${ms(p.loginAt)}` : null,
      p.logoutAt !== undefined ? sql`logout_at = ${ms(p.logoutAt)}` : null,
      p.siteId !== undefined ? sql`site_id = ${p.siteId}` : null,
      p.shiftId !== undefined ? sql`shift_id = ${p.shiftId}` : null,
      p.workedMinutes !== undefined ? sql`worked_minutes = ${p.workedMinutes}` : null,
      p.state !== undefined ? sql`state = ${p.state}` : null,
      sql`updated_at = ${now.getTime()}`,
    ].filter(Boolean);

    statements.push(
      prepare(
        db,
        sql`UPDATE attendance_sessions
            SET ${sql.join(sets as never[], sql`, `)}
            WHERE id = ${plan.session.id} AND ${guard}`,
      ),
    );
  } else {
    const r = plan.session.row;
    // INSERT ... SELECT ... WHERE EXISTS, so the insert carries the same guard
    // the updates do. A plain INSERT could not be conditional, and would be the
    // one statement able to land on its own.
    statements.push(
      prepare(
        db,
        sql`INSERT INTO attendance_sessions (
          id, organization_id, worker_id, site_id, shift_id, work_date,
          login_at, logout_at, state, worked_minutes, is_cross_site,
          created_at, updated_at
        )
        SELECT ${r.id}, ${r.organizationId}, ${r.workerId}, ${r.siteId}, ${r.shiftId},
               ${r.workDate}, ${ms(r.loginAt)}, ${ms(r.logoutAt)}, ${r.state},
               ${r.workedMinutes}, 0, ${now.getTime()}, ${now.getTime()}
            WHERE ${guard}`,
      ),
    );
  }

  // Marking the request applied is last, and carries the guard too. Two
  // reviewers arriving together therefore cannot both succeed: whichever batch
  // commits first flips the status, and the other one's guard is false by the
  // time it runs, so it writes nothing at all.
  statements.push(
    prepare(
      db,
      sql`UPDATE correction_requests
      SET status = 'APPLIED',
          reviewed_by = ${plan.reviewedBy},
          reviewed_at = ${now.getTime()},
          review_notes = ${plan.reviewNotes ?? null},
          auto_applied = ${plan.autoApplied ? 1 : 0},
          updated_at = ${now.getTime()}
          WHERE id = ${plan.requestId} AND status = 'PENDING'`,
    ),
  );

  // One batch: a SQL transaction, rolled back whole if any statement errors.
  const results = await db.batch(statements);

  // The last statement is the request update. If it changed nothing, the guard
  // was false and — because every other statement carried the same guard —
  // nothing else changed either.
  const last = results[results.length - 1] as { meta?: { changes?: number } };
  return (last?.meta?.changes ?? 0) > 0;
}
