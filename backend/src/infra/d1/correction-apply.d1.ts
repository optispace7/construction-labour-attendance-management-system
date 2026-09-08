import { businessDate, minutesOfDay } from '../../common/time/time.util';
import { computeWorkHours, ShiftConfig } from '../../modules/attendance/engine/work-hours.engine';
import { Errors } from '../../common/errors/app.exception';

/**
 * The attendance-correction apply, on D1.
 *
 * A faithful port of applyInTx, which on Postgres runs inside one interactive
 * transaction. D1 has none, so the work is split in two: everything that reads
 * or decides happens first and produces a plan, and the plan is then written as
 * a single guarded batch. See correction-apply.ts for why that is safe.
 *
 * The split is not only a workaround. On Postgres the code writes the session,
 * reads the row back, notices the work date should move, writes again, then
 * recomputes hours and writes a third time. Deciding everything up front
 * collapses those three writes into one, which is both cheaper and easier to
 * reason about — there is no intermediate row state that anything can observe.
 *
 * Two details that are easy to lose in the move, and are not lost here:
 *
 * The work date follows the *corrected* site's timezone, not the old one. The
 * Postgres version gets that for free by re-reading the row after the update;
 * here the target site is fetched deliberately when the correction moves it.
 *
 * The hours follow the *corrected* shift for the same reason.
 */

type Row = Record<string, unknown>;

const asDate = (v: unknown): Date | null => (v == null ? null : new Date(Number(v)));
const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
const day = (d: Date) => d.toISOString().slice(0, 10);

export interface CorrectionActor {
  userId: string;
  organizationId: string;
}

export interface ApplyResult {
  applied: boolean;
  sessionId: string | null;
  /** What the session held before, for the audit entry. */
  before: Row | null;
  after: Row | null;
}

/**
 * Reads, validates and writes. Throws the same errors the Postgres path throws,
 * so the API's responses are unchanged.
 */
export async function applyCorrectionOnD1(
  db: D1Database,
  actor: CorrectionActor,
  requestId: string,
  opts: { reviewNotes?: string | null; autoApplied?: boolean } = {},
  now: Date = new Date(),
): Promise<ApplyResult> {
  // ---- reads ----------------------------------------------------------
  const req = (await db
    .prepare(`SELECT * FROM correction_requests WHERE id = ? AND organization_id = ?`)
    .bind(requestId, actor.organizationId)
    .first()) as Row | null;
  if (!req) throw Errors.notFound('Correction request');
  if (req.status !== 'PENDING') throw Errors.businessRule('Request is not pending');

  const items = (
    await db.prepare(`SELECT * FROM correction_items WHERE request_id = ?`).bind(requestId).all()
  ).results as Row[];

  // ---- what the correction proposes -----------------------------------
  const patch: {
    loginAt?: Date;
    logoutAt?: Date;
    siteId?: string;
    shiftId?: string;
  } = {};
  for (const item of items) {
    const raw = item.proposed_value as string;
    const v = JSON.parse(raw) as unknown;
    switch (item.field) {
      case 'login_at':
        patch.loginAt = new Date(v as string);
        break;
      case 'logout_at':
        patch.logoutAt = new Date(v as string);
        break;
      case 'site_id':
        patch.siteId = v as string;
        break;
      case 'shift_id':
        patch.shiftId = v as string;
        break;
      default:
        throw Errors.businessRule(`Unsupported correction field: ${item.field}`);
    }
  }

  const site = (await db
    .prepare(
      `SELECT s.*, ss.default_shift_id FROM sites s
       LEFT JOIN site_settings ss ON ss.site_id = s.id
       WHERE s.id = ? AND s.organization_id = ?`,
    )
    .bind(req.site_id, req.organization_id)
    .first()) as Row | null;
  if (!site) throw Errors.notFound('Site');

  // Which day does this correction mean? NOT req.work_date — the mobile builds
  // that from local midnight and converts to UTC, so at +05:30 it lands on the
  // previous day. The proposed timestamp is an unambiguous instant, so the day
  // is derived from it and work_date is only the fallback.
  const anchor = patch.loginAt ?? patch.logoutAt;
  const targetDate = anchor
    ? businessDate(anchor, site.timezone as string)
    : new Date(`${req.work_date as string}T00:00:00.000Z`);

  // ---- find the session this means -------------------------------------
  let session: Row | null = null;
  if (req.session_id) {
    session = (await db
      .prepare(`SELECT * FROM attendance_sessions WHERE id = ?`)
      .bind(req.session_id)
      .first()) as Row | null;
  } else {
    // Which of the day's sessions does a logout correction mean? The latest one
    // that had already started by then — not simply the latest, which once put
    // an 18:19 logout onto a stray tap made at 19:14 and left both men it hit
    // reading zero hours.
    const startedBefore = patch.logoutAt && !patch.loginAt ? ms(patch.logoutAt) : null;
    // Two separate statements rather than one with a null-tolerant predicate:
    // the parameterised version needed the same bind twice and read as a
    // puzzle, and a query this important should be legible at a glance.
    session = (
      startedBefore === null
        ? await db
            .prepare(
              `SELECT * FROM attendance_sessions
                WHERE organization_id = ? AND worker_id = ? AND work_date = ?
                ORDER BY login_at DESC LIMIT 1`,
            )
            .bind(req.organization_id, req.worker_id, day(targetDate))
            .first()
        : await db
            .prepare(
              `SELECT * FROM attendance_sessions
                WHERE organization_id = ? AND worker_id = ? AND work_date = ? AND login_at < ?
                ORDER BY login_at DESC LIMIT 1`,
            )
            .bind(req.organization_id, req.worker_id, day(targetDate), startedBefore)
            .first()
    ) as Row | null;
  }

  // A night shift's logout falls on the next calendar day, so a logout-only
  // correction resolves to a day with no session of its own. The row it means is
  // the one still running from the evening before. A session still OPEN is the
  // one this logout is for; only if there is none does a closed shift come into
  // it, or a stray request would stretch a finished day shift across the night.
  if (!session && !req.session_id && patch.logoutAt && !patch.loginAt) {
    const upper = ms(patch.logoutAt) as number;
    const lower = upper - 24 * 60 * 60 * 1000;
    session =
      ((await db
        .prepare(
          `SELECT * FROM attendance_sessions
            WHERE organization_id = ? AND worker_id = ? AND login_at < ? AND login_at >= ?
              AND state = 'OPEN' ORDER BY login_at DESC LIMIT 1`,
        )
        .bind(req.organization_id, req.worker_id, upper, lower)
        .first()) as Row | null) ??
      ((await db
        .prepare(
          `SELECT * FROM attendance_sessions
            WHERE organization_id = ? AND worker_id = ? AND login_at < ? AND login_at >= ?
            ORDER BY login_at DESC LIMIT 1`,
        )
        .bind(req.organization_id, req.worker_id, upper, lower)
        .first()) as Row | null);
  }

  if (req.session_id && !session) throw Errors.conflict('Target session no longer exists');

  // Freshness: a pinned session that changed after the request was filed is no
  // longer the row the requester saw. Sessions resolved by date are exempt —
  // they are looked up fresh, so "current row wins" is intended.
  if (
    req.session_id &&
    session &&
    Number(session.updated_at) > Number(req.created_at)
  ) {
    throw Errors.conflict('Session changed since the request was filed; please re-file');
  }

  // A logout before its own login is a typo, not a correction. Nothing
  // downstream rejects it: the session closes with negative time, the hours
  // engine floors it to zero, and the day quietly reads as worked-nothing.
  const finalLoginAt = patch.loginAt ?? asDate(session?.login_at);
  const finalLogoutAt = patch.logoutAt ?? asDate(session?.logout_at);
  if (finalLoginAt && finalLogoutAt && finalLogoutAt <= finalLoginAt) {
    throw Errors.businessRule(
      'The corrected logout time is not after the login time. Fix the times on the ' +
        'request — approving this would record the day as zero hours worked.',
    );
  }

  // ---- decide the final row -------------------------------------------
  const creating = !session;
  if (creating) {
    if (!patch.loginAt) {
      throw Errors.conflict(
        `No attendance session for ${day(targetDate)}, and no shift running into that time ` +
          'from the day before. The correction must propose a login time.',
      );
    }
    // Only one OPEN session per worker is allowed, so a login-only correction
    // cannot be materialised while the worker is clocked in somewhere else.
    if (!patch.logoutAt) {
      const open = (await db
        .prepare(
          `SELECT s.login_at, si.name AS site_name, si.timezone
             FROM attendance_sessions s JOIN sites si ON si.id = s.site_id
            WHERE s.worker_id = ? AND s.state = 'OPEN' LIMIT 1`,
        )
        .bind(req.worker_id)
        .first()) as Row | null;
      if (open) {
        // Name the day in the way: the conflicting session is usually today,
        // while the correction is for a day gone by, and an approver reading
        // "already has an open session" has no way to guess that.
        const openDay = day(
          businessDate(asDate(open.login_at) as Date, open.timezone as string),
        );
        throw Errors.conflict(
          `This correction would open a second session for ${day(targetDate)}, but the worker ` +
            `is still clocked in from ${openDay} at ${open.site_name as string}. A worker can ` +
            'only have one session open at a time. Add a logout time to the correction — a ' +
            'past day needs one anyway — or close the open session first.',
        );
      }
    }
  }

  const finalSiteId = patch.siteId ?? (session?.site_id as string) ?? (req.site_id as string);
  const finalShiftId =
    patch.shiftId ??
    (session?.shift_id as string | null) ??
    (site.default_shift_id as string | null) ??
    null;

  // The work date follows the corrected site's timezone, so fetch that site when
  // the correction moves it rather than reusing the request's.
  const finalSite =
    finalSiteId === site.id
      ? site
      : ((await db
          .prepare(`SELECT * FROM sites WHERE id = ?`)
          .bind(finalSiteId)
          .first()) as Row | null);
  if (!finalSite) throw Errors.notFound('Site');

  const loginAt = (patch.loginAt ?? asDate(session?.login_at)) as Date;
  const logoutAt = patch.logoutAt ?? asDate(session?.logout_at);
  const workDate = day(businessDate(loginAt, finalSite.timezone as string));

  let workedMinutes: number | null = (session?.worked_minutes as number) ?? null;
  let overtimeMinutes: number | null = (session?.overtime_minutes as number) ?? null;
  let lateMinutes: number | null = (session?.late_minutes as number) ?? null;
  let earlyLeaveMinutes: number | null = (session?.early_leave_minutes as number) ?? null;
  let state = (session?.state as string) ?? 'OPEN';
  let closedReason = (session?.closed_reason as string) ?? null;

  if (logoutAt) {
    const shift = finalShiftId
      ? ((await db
          .prepare(`SELECT * FROM shifts WHERE id = ?`)
          .bind(finalShiftId)
          .first()) as Row | null)
      : null;
    const shiftCfg: ShiftConfig | undefined = shift
      ? {
          startTimeMinutes: minutesOfDay(new Date(`1970-01-01T${shift.start_time as string}Z`)),
          endTimeMinutes: minutesOfDay(new Date(`1970-01-01T${shift.end_time as string}Z`)),
          isOvernight: !!shift.is_overnight,
          lateGraceMinutes: Number(shift.late_grace_minutes ?? 0),
          earlyGraceMinutes: Number(shift.early_grace_minutes ?? 0),
          otThresholdMinutes: Number(shift.ot_threshold_minutes ?? 0),
        }
      : undefined;
    const hours = computeWorkHours(loginAt, logoutAt, finalSite.timezone as string, shiftCfg);
    workedMinutes = hours.workedMinutes;
    overtimeMinutes = hours.overtimeMinutes;
    lateMinutes = hours.lateMinutes;
    earlyLeaveMinutes = hours.earlyLeaveMinutes;
    state = 'CLOSED';
    closedReason = 'CORRECTION';
  }

  const sessionId = (session?.id as string) ?? crypto.randomUUID();
  const before = session
    ? {
        loginAt: asDate(session.login_at),
        logoutAt: asDate(session.logout_at),
        siteId: session.site_id,
        shiftId: session.shift_id,
        workDate: session.work_date,
      }
    : null;

  // ---- one guarded batch ----------------------------------------------
  // Every statement carries the same predicate, so a request somebody else
  // reviewed in the meantime writes nothing at all rather than half of it.
  const guard = `EXISTS (SELECT 1 FROM correction_requests WHERE id = ? AND status = 'PENDING')`;

  const write = creating
    ? db
        .prepare(
          `INSERT INTO attendance_sessions (
             id, organization_id, worker_id, site_id, shift_id, work_date, login_at, logout_at,
             state, worked_minutes, overtime_minutes, late_minutes, early_leave_minutes,
             closed_reason, is_cross_site, created_at, updated_at)
           SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,? WHERE ${guard}`,
        )
        .bind(
          sessionId, req.organization_id, req.worker_id, finalSiteId, finalShiftId, workDate,
          ms(loginAt), ms(logoutAt), state, workedMinutes, overtimeMinutes, lateMinutes,
          earlyLeaveMinutes, closedReason, now.getTime(), now.getTime(), requestId,
        )
    : db
        .prepare(
          `UPDATE attendance_sessions
              SET site_id = ?, shift_id = ?, work_date = ?, login_at = ?, logout_at = ?,
                  state = ?, worked_minutes = ?, overtime_minutes = ?, late_minutes = ?,
                  early_leave_minutes = ?, closed_reason = ?, updated_at = ?
            WHERE id = ? AND ${guard}`,
        )
        .bind(
          finalSiteId, finalShiftId, workDate, ms(loginAt), ms(logoutAt), state, workedMinutes,
          overtimeMinutes, lateMinutes, earlyLeaveMinutes, closedReason, now.getTime(),
          sessionId, requestId,
        );

  const markReviewed = db
    .prepare(
      `UPDATE correction_requests
          SET status = 'APPROVED', reviewed_by = ?, reviewed_at = ?, review_notes = ?,
              auto_applied = ?, session_id = COALESCE(session_id, ?), updated_at = ?
        WHERE id = ? AND status = 'PENDING'`,
    )
    .bind(
      actor.userId, now.getTime(), opts.reviewNotes ?? null, opts.autoApplied ? 1 : 0,
      sessionId, now.getTime(), requestId,
    );

  const results = await db.batch([write, markReviewed]);
  const applied = ((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0) > 0;

  return {
    applied,
    sessionId: applied ? sessionId : null,
    before,
    after: applied
      ? { loginAt, logoutAt, siteId: finalSiteId, shiftId: finalShiftId, workDate }
      : null,
  };
}
