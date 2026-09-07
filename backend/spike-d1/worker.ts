import { sql } from 'drizzle-orm';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import { applyCorrectionPlan, type ApplyPlan } from '../src/infra/d1/correction-apply';

interface Env { DB: D1Database }

const SITE = 'site-1';
const ORG = 'org-1';
const WORKER = 'worker-9';
const SESSION = 'sess-9';
const REQUEST = 'req-9';

/** Puts the scenario back to a known state before each case. */
async function reset(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM correction_items WHERE request_id = ?`).bind(REQUEST),
    env.DB.prepare(`DELETE FROM correction_requests WHERE id = ?`).bind(REQUEST),
    env.DB.prepare(`DELETE FROM attendance_sessions WHERE id = ?`).bind(SESSION),
  ]);
  const t = 1757000000000;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attendance_sessions (id, organization_id, worker_id, site_id, work_date,
        login_at, logout_at, state, worked_minutes, is_cross_site, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
    ).bind(SESSION, ORG, WORKER, SITE, '2026-09-08', t, t + 3600000, 'CLOSED', 60, t, t),
    env.DB.prepare(
      `INSERT INTO correction_requests (id, organization_id, worker_id, site_id, session_id,
        work_date, type, reason, requested_by, status, auto_applied, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'PENDING',0,?,?)`,
    ).bind(REQUEST, ORG, WORKER, SITE, SESSION, '2026-09-08', 'LOGOUT', 'FORGOT', 'user-1', t, t),
  ]);
}

async function snapshot(env: Env) {
  const s = await env.DB.prepare(
    `SELECT login_at, logout_at, worked_minutes, state FROM attendance_sessions WHERE id = ?`,
  ).bind(SESSION).first();
  const r = await env.DB.prepare(
    `SELECT status, reviewed_by FROM correction_requests WHERE id = ?`,
  ).bind(REQUEST).first();
  return { session: s, request: r };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const dialect = new SQLiteAsyncDialect();
    const q = (t: ReturnType<typeof sql>) => {
      const { sql: text, params } = dialect.sqlToQuery(t);
      return env.DB.prepare(text).bind(...(params as unknown[]));
    };
    const path = new URL(request.url).pathname;
    const newLogout = new Date(1757000000000 + 8 * 3600000);

    const plan: ApplyPlan = {
      requestId: REQUEST,
      reviewedBy: 'user-2',
      reviewNotes: 'approved',
      autoApplied: false,
      session: {
        kind: 'update',
        id: SESSION,
        patch: { logoutAt: newLogout, workedMinutes: 480, state: 'CLOSED' },
      },
    };

    try {
      if (path === '/success') {
        await reset(env);
        const before = await snapshot(env);
        const applied = await applyCorrectionPlan(env.DB, plan);
        return Response.json({ case: 'success', applied, before, after: await snapshot(env) });
      }

      if (path === '/fail-midway') {
        await reset(env);
        const before = await snapshot(env);
        // A second statement that is guaranteed to fail: writing a duplicate
        // primary key. It stands in for anything going wrong after the session
        // write has already been queued — which is exactly the moment a partial
        // application would happen if the batch were not atomic.
        let error: string | null = null;
        try {
          await env.DB.batch([
            q(sql`
              UPDATE attendance_sessions
              SET logout_at = ${newLogout.getTime()}, worked_minutes = 480
              WHERE id = ${SESSION}
                AND EXISTS (SELECT 1 FROM correction_requests WHERE id = ${REQUEST} AND status = 'PENDING')
            `),
            q(sql`INSERT INTO attendance_sessions (id, organization_id, worker_id, site_id,
                        work_date, login_at, state, is_cross_site, created_at, updated_at)
                       VALUES (${SESSION}, ${ORG}, ${WORKER}, ${SITE}, '2026-09-08', 1, 'CLOSED', 0, 1, 1)`),
            q(sql`UPDATE correction_requests SET status = 'APPLIED' WHERE id = ${REQUEST}`),
          ]);
        } catch (e) {
          error = String(e).slice(0, 120);
        }
        return Response.json({
          case: 'fail-midway',
          error,
          before,
          after: await snapshot(env),
        });
      }

      if (path === '/race') {
        await reset(env);
        // Somebody else reviewed it first.
        await env.DB.prepare(
          `UPDATE correction_requests SET status = 'APPLIED', reviewed_by = 'user-first' WHERE id = ?`,
        ).bind(REQUEST).run();
        const before = await snapshot(env);
        const applied = await applyCorrectionPlan(env.DB, plan);
        return Response.json({ case: 'race', applied, before, after: await snapshot(env) });
      }

      return Response.json({ cases: ['/success', '/fail-midway', '/race'] });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
};
