import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { createTestD1, insert, TestD1 } from './d1-harness';
import * as schema from '../src/infra/d1/schema.generated';

/**
 * A minimal but real world for the correction tests: one org, one site, one
 * worker, one reviewer.
 *
 * Everything here is written through the actual schema, so a fixture that
 * would violate a constraint in production fails to build here too.
 */
export const ORG = 'org1';
export const SITE = 'site1';
export const WORKER = 'w1';
export const USER = 'u1';

export const actor = {
  userId: USER,
  organizationId: ORG,
  role: 'SITE_ADMIN',
  siteScopes: [] as string[],
};

const t = (iso: string) => new Date(iso).getTime();

export interface World extends TestD1 {
  /** The same database through Drizzle, which is how the services read it. */
  drizzle: DrizzleD1Database<typeof schema>;
  /** Put a session on the books. Returns its id. */
  session(row: Partial<SessionRow> & { id: string }): Promise<string>;
  /** File a correction request with its items. Returns its id. */
  request(
    row: Partial<RequestRow> & { id: string },
    items: { field: string; proposedValue: string }[],
  ): Promise<string>;
  /** A session as stored, so a test reads what D1 holds. */
  readSession(id: string): Promise<Record<string, unknown> | null>;
  readRequest(id: string): Promise<Record<string, unknown> | null>;
}

interface SessionRow {
  id: string;
  workerId: string;
  siteId: string;
  shiftId: string | null;
  workDate: string;
  loginAt: string;
  logoutAt: string | null;
  state: string;
  updatedAt: string;
}

interface RequestRow {
  id: string;
  sessionId: string | null;
  workDate: string;
  createdAt: string;
  status: string;
  requestedBy: string;
}

export async function makeWorld(
  opts: { timezone?: string; canApplyCorrections?: boolean } = {},
): Promise<World> {
  const base = await createTestD1();
  const { db } = base;
  const now = Date.now();

  await insert(db, 'organizations', {
    id: ORG,
    name: 'Optispace',
    code: 'OPS',
    timezone: opts.timezone ?? 'Asia/Kolkata',
    is_active: 1,
    logo_scale: 1,
    created_at: now,
    updated_at: now,
  });
  await insert(db, 'sites', {
    id: SITE,
    organization_id: ORG,
    name: 'Tower A',
    code: 'TA',
    timezone: opts.timezone ?? 'Asia/Kolkata',
    is_active: 1,
    created_at: now,
    updated_at: now,
  });
  await insert(db, 'site_settings', {
    site_id: SITE,
    verification_mode: 'AUTO',
    auto_login_countdown_seconds: 10,
    duplicate_tap_cooldown_seconds: 30,
    safety_gap_minutes: 0,
    geo_enforcement: 0,
    geo_radius_meters: 200,
    photo_verification_mode: 'NEVER',
    photo_verification_random_pct: 0,
    updated_at: now,
  });
  await insert(db, 'workers', {
    id: WORKER,
    organization_id: ORG,
    worker_code: 'W-0001',
    full_name: 'Ramesh',
    category: 'WORKER',
    status: 'ACTIVE',
    created_at: now,
    updated_at: now,
  });
  await insert(db, 'users', {
    id: USER,
    organization_id: ORG,
    role: 'SITE_ADMIN',
    full_name: 'Reviewer',
    is_active: 1,
    can_apply_corrections: opts.canApplyCorrections ? 1 : 0,
    created_at: now,
    updated_at: now,
  });

  return {
    ...base,
    drizzle: drizzle(db, { schema }),
    async session(row) {
      await insert(db, 'attendance_sessions', {
        id: row.id,
        organization_id: ORG,
        worker_id: row.workerId ?? WORKER,
        site_id: row.siteId ?? SITE,
        shift_id: row.shiftId ?? null,
        work_date: row.workDate ?? '2026-06-08',
        login_at: t(row.loginAt ?? '2026-06-08T03:30:00Z'),
        logout_at: row.logoutAt ? t(row.logoutAt) : null,
        state: row.state ?? 'OPEN',
        is_cross_site: 0,
        created_at: now,
        updated_at: t(row.updatedAt ?? '2026-06-08T09:00:00Z'),
      });
      return row.id;
    },
    async request(row, items) {
      await insert(db, 'correction_requests', {
        id: row.id,
        organization_id: ORG,
        worker_id: WORKER,
        site_id: SITE,
        session_id: row.sessionId ?? null,
        work_date: row.workDate ?? '2026-06-08',
        type: 'TIME',
        reason: 'MISSED_LOGOUT',
        requested_by: row.requestedBy ?? USER,
        status: row.status ?? 'PENDING',
        auto_applied: 0,
        created_at: t(row.createdAt ?? '2026-06-08T10:00:00Z'),
        updated_at: t(row.createdAt ?? '2026-06-08T10:00:00Z'),
      });
      for (const [i, item] of items.entries()) {
        await insert(db, 'correction_items', {
          id: `${row.id}-i${i}`,
          request_id: row.id,
          field: item.field,
          proposed_value: JSON.stringify(item.proposedValue),
        });
      }
      return row.id;
    },
    readSession: (id) =>
      db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').bind(id).first() as Promise<
        Record<string, unknown> | null
      >,
    readRequest: (id) =>
      db.prepare('SELECT * FROM correction_requests WHERE id = ?').bind(id).first() as Promise<
        Record<string, unknown> | null
      >,
  };
}

/** The one session a worker has, whatever its id — for create-path assertions. */
export async function onlySession(w: World) {
  const rows = (await w.db.prepare('SELECT * FROM attendance_sessions').all()).results as Record<
    string,
    unknown
  >[];
  return rows.length === 1 ? rows[0] : null;
}
