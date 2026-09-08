import { applyCorrectionOnD1 } from '../src/infra/d1/correction-apply.d1';

/**
 * The correction suite, run against a real D1 database.
 *
 * These are the scenarios corrections.service.spec.ts covers against Postgres,
 * rewritten to seed actual rows rather than mock a transaction client. Mocks
 * would prove the port compiles; the question is whether it behaves, and that
 * only the real database can answer — particularly for the cases that end in a
 * refusal, where what matters is that nothing was written.
 */

interface Env {
  DB: D1Database;
}

const ORG = 'org-1';
const ACTOR = { userId: 'user-2', organizationId: ORG };
const T = Date.UTC(2026, 8, 8, 0, 0, 0);
const h = (n: number) => T + n * 3600000;

interface SeedSession {
  id: string;
  workDate: string;
  loginAt: number;
  logoutAt?: number | null;
  state?: string;
  workedMinutes?: number | null;
  siteId?: string;
  workerId?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface Seed {
  sessions?: SeedSession[];
  request: Record<string, unknown>;
  items: { field: string; value: unknown }[];
}

type Row = Record<string, unknown>;

async function reset(db: D1Database, seed: Seed): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM correction_items'),
    db.prepare('DELETE FROM correction_requests'),
    db.prepare('DELETE FROM attendance_sessions'),
    db.prepare('DELETE FROM site_settings'),
    db.prepare('DELETE FROM shifts'),
    db.prepare('DELETE FROM sites'),
  ]);

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        'INSERT INTO sites (id,organization_id,name,code,timezone,is_active,created_at,updated_at) ' +
          "VALUES ('site-1',?,'Main','M1','Asia/Kolkata',1,?,?)",
      )
      .bind(ORG, T, T),
    db.prepare('INSERT INTO site_settings (site_id,updated_at) VALUES (?,?)').bind('site-1', T),
  ];

  for (const s of seed.sessions ?? []) {
    stmts.push(
      db
        .prepare(
          'INSERT INTO attendance_sessions (id,organization_id,worker_id,site_id,work_date,' +
            'login_at,logout_at,state,worked_minutes,is_cross_site,created_at,updated_at) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,0,?,?)',
        )
        .bind(
          s.id,
          ORG,
          s.workerId ?? 'w-1',
          s.siteId ?? 'site-1',
          s.workDate,
          s.loginAt,
          s.logoutAt ?? null,
          s.state ?? 'CLOSED',
          s.workedMinutes ?? null,
          s.createdAt ?? T,
          s.updatedAt ?? T,
        ),
    );
  }

  const r = seed.request;
  stmts.push(
    db
      .prepare(
        'INSERT INTO correction_requests (id,organization_id,worker_id,site_id,session_id,' +
          'work_date,type,reason,requested_by,status,auto_applied,created_at,updated_at) ' +
          "VALUES ('req-1',?,?,?,?,?,?,'FORGOT','user-1','PENDING',0,?,?)",
      )
      .bind(
        ORG,
        (r.workerId as string) ?? 'w-1',
        (r.siteId as string) ?? 'site-1',
        (r.sessionId as string) ?? null,
        r.workDate as string,
        (r.type as string) ?? 'LOGOUT',
        (r.createdAt as number) ?? T,
        (r.createdAt as number) ?? T,
      ),
  );

  seed.items.forEach((it, i) =>
    stmts.push(
      db
        .prepare(
          'INSERT INTO correction_items (id,request_id,field,proposed_value) VALUES (?,?,?,?)',
        )
        .bind('item-' + String(i), 'req-1', it.field, JSON.stringify(it.value)),
    ),
  );

  await db.batch(stmts);
}

async function state(db: D1Database) {
  const sessions = (
    await db
      .prepare(
        'SELECT id, work_date, login_at, logout_at, state, worked_minutes, site_id ' +
          'FROM attendance_sessions ORDER BY login_at',
      )
      .all()
  ).results as Row[];
  const request = (await db
    .prepare("SELECT status, session_id, reviewed_by FROM correction_requests WHERE id='req-1'")
    .first()) as Row | null;
  return { sessions, request };
}

type Check = (outcome: unknown, after: Awaited<ReturnType<typeof state>>) => string | null;

async function run(db: D1Database, name: string, seed: Seed, check: Check) {
  await reset(db, seed);
  let outcome: unknown = null;
  try {
    outcome = await applyCorrectionOnD1(db, ACTOR, 'req-1');
  } catch (e) {
    outcome = (e as { code?: string }).code ?? String((e as Error).message ?? e);
  }
  const after = await state(db);
  const problem = check(outcome, after);
  return { name, pass: !problem, problem, outcome, after };
}

const applied = (o: unknown) => (o as { applied?: boolean })?.applied === true;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = env.DB;
    if (new URL(request.url).pathname !== '/tests') {
      return Response.json({ run: '/tests' });
    }

    const tests = [];

    tests.push(
      await run(
        db,
        'aborts when a pinned session changed after the request was filed',
        {
          sessions: [
            { id: 's1', workDate: '2026-09-08', loginAt: h(2), logoutAt: h(10), updatedAt: T + 5000 },
          ],
          request: { sessionId: 's1', workDate: '2026-09-08', createdAt: T },
          items: [{ field: 'logout_at', value: new Date(h(11)).toISOString() }],
        },
        (o, a) => {
          if (o !== 'CONFLICT') return 'expected CONFLICT, got ' + JSON.stringify(o);
          if (a.sessions[0].logout_at !== h(10)) return 'the session was modified anyway';
          if (a.request?.status !== 'PENDING') return 'the request was modified anyway';
          return null;
        },
      ),
    );

    tests.push(
      await run(
        db,
        'resolves the session by worker and work date when none is pinned',
        {
          sessions: [{ id: 's1', workDate: '2026-09-08', loginAt: h(2), logoutAt: h(10) }],
          request: { workDate: '2026-09-08' },
          items: [{ field: 'logout_at', value: new Date(h(11)).toISOString() }],
        },
        (o, a) => {
          if (!applied(o)) return 'not applied: ' + JSON.stringify(o);
          if (a.sessions[0].logout_at !== h(11)) return 'the logout was not updated';
          if (a.request?.session_id !== 's1') return 'the request was not linked to the session';
          return null;
        },
      ),
    );

    tests.push(
      await run(
        db,
        'refiles the session under the corrected login date',
        {
          sessions: [{ id: 's1', workDate: '2026-09-08', loginAt: h(2), logoutAt: h(10) }],
          request: { workDate: '2026-09-08' },
          items: [{ field: 'login_at', value: new Date(h(-6)).toISOString() }],
        },
        (o, a) => {
          if (!applied(o)) return 'not applied: ' + JSON.stringify(o);
          // 18:00Z on the 7th is 23:30 IST on the 7th, so the day is the 7th.
          if (a.sessions[0].work_date !== '2026-09-07') {
            return 'work_date is ' + String(a.sessions[0].work_date) + ', expected 2026-09-07';
          }
          return null;
        },
      ),
    );

    tests.push(
      await run(
        db,
        'refuses a logout that lands before the login it belongs to',
        {
          sessions: [{ id: 's1', workDate: '2026-09-08', loginAt: h(10), logoutAt: h(18) }],
          request: { sessionId: 's1', workDate: '2026-09-08', createdAt: T + 10000 },
          items: [{ field: 'logout_at', value: new Date(h(4)).toISOString() }],
        },
        (o, a) => {
          if (o !== 'BUSINESS_RULE') return 'expected BUSINESS_RULE, got ' + JSON.stringify(o);
          if (a.sessions[0].logout_at !== h(18)) return 'the session was modified anyway';
          return null;
        },
      ),
    );

    tests.push(
      await run(
        db,
        'refuses a logout-only correction with no session to attach it to',
        {
          sessions: [],
          request: { workDate: '2026-09-08' },
          items: [{ field: 'logout_at', value: new Date(h(10)).toISOString() }],
        },
        (o, a) => {
          if (o !== 'CONFLICT') return 'expected CONFLICT, got ' + JSON.stringify(o);
          if (a.sessions.length !== 0) return 'a session was invented';
          return null;
        },
      ),
    );

    tests.push(
      await run(
        db,
        'refuses a login-only correction while the worker is still clocked in',
        {
          sessions: [
            { id: 'open', workDate: '2026-09-09', loginAt: h(30), logoutAt: null, state: 'OPEN' },
          ],
          request: { workDate: '2026-09-08' },
          items: [{ field: 'login_at', value: new Date(h(2)).toISOString() }],
        },
        (o, a) => {
          if (o !== 'CONFLICT') return 'expected CONFLICT, got ' + JSON.stringify(o);
          if (a.sessions.length !== 1) return 'a second session was created';
          return null;
        },
      ),
    );

    tests.push(
      await run(
        db,
        'creates the session CLOSED, with hours, when a logout is supplied',
        {
          sessions: [],
          request: { workDate: '2026-09-08', type: 'MISSING' },
          items: [
            { field: 'login_at', value: new Date(h(3)).toISOString() },
            { field: 'logout_at', value: new Date(h(11)).toISOString() },
          ],
        },
        (o, a) => {
          if (!applied(o)) return 'not applied: ' + JSON.stringify(o);
          if (a.sessions.length !== 1) return 'expected 1 session, got ' + String(a.sessions.length);
          const s = a.sessions[0];
          if (s.state !== 'CLOSED') return 'state is ' + String(s.state);
          if (s.worked_minutes !== 480) {
            return 'worked_minutes is ' + String(s.worked_minutes) + ', expected 480';
          }
          return null;
        },
      ),
    );

    tests.push(
      await run(
        db,
        'closes the night shift running into the day a logout correction names',
        {
          sessions: [
            { id: 'night', workDate: '2026-09-07', loginAt: h(-4), logoutAt: null, state: 'OPEN' },
          ],
          request: { workDate: '2026-09-08' },
          items: [{ field: 'logout_at', value: new Date(h(3)).toISOString() }],
        },
        (o, a) => {
          if (!applied(o)) return 'not applied: ' + JSON.stringify(o);
          const s = a.sessions[0];
          if (s.id !== 'night') return 'closed the wrong session: ' + String(s.id);
          if (s.state !== 'CLOSED') return 'state is ' + String(s.state);
          return null;
        },
      ),
    );

    tests.push(
      await run(
        db,
        'applies a logout to the shift it can close, not a later stray tap',
        {
          sessions: [
            { id: 'real', workDate: '2026-09-08', loginAt: h(2), logoutAt: null, state: 'OPEN' },
            { id: 'stray', workDate: '2026-09-08', loginAt: h(19), logoutAt: h(20) },
          ],
          request: { workDate: '2026-09-08' },
          items: [{ field: 'logout_at', value: new Date(h(18)).toISOString() }],
        },
        (o, a) => {
          if (!applied(o)) return 'not applied: ' + JSON.stringify(o);
          const real = a.sessions.find((s) => s.id === 'real') as Row;
          const stray = a.sessions.find((s) => s.id === 'stray') as Row;
          if (real.logout_at !== h(18)) return 'the real shift was not closed';
          if (stray.logout_at !== h(20)) return 'the stray tap was modified';
          return null;
        },
      ),
    );

    // Reviewed by somebody else in the meantime. Seeded after reset, so it
    // cannot be expressed through the seed shape.
    tests.push(
      await (async () => {
        await reset(db, {
          sessions: [{ id: 's1', workDate: '2026-09-08', loginAt: h(2), logoutAt: h(10) }],
          request: { workDate: '2026-09-08' },
          items: [{ field: 'logout_at', value: new Date(h(11)).toISOString() }],
        });
        await db
          .prepare(
            "UPDATE correction_requests SET status='APPROVED', reviewed_by='first' WHERE id='req-1'",
          )
          .run();
        let outcome: unknown = null;
        try {
          outcome = await applyCorrectionOnD1(db, ACTOR, 'req-1');
        } catch (e) {
          outcome = (e as { code?: string }).code ?? String(e);
        }
        const after = await state(db);
        const problem =
          outcome !== 'BUSINESS_RULE'
            ? 'expected BUSINESS_RULE, got ' + JSON.stringify(outcome)
            : after.sessions[0].logout_at !== h(10)
              ? 'the session was modified by a second review'
              : after.request?.reviewed_by !== 'first'
                ? 'the first reviewer was overwritten'
                : null;
        return {
          name: 'refuses a second review and leaves the first standing',
          pass: !problem,
          problem,
          outcome,
          after,
        };
      })(),
    );

    const passed = tests.filter((t) => t.pass).length;
    return Response.json(
      { passed, of: tests.length, failures: tests.filter((t) => !t.pass), tests },
      { status: passed === tests.length ? 200 : 500 },
    );
  },
};
