import { drizzle } from 'drizzle-orm/d1';
import { createTestD1, insert, TestD1 } from './d1-harness';
import * as schema from '../src/infra/d1/schema.generated';

/**
 * A real database for the safety board's tests.
 *
 * These used to run against a Prisma double that re-implemented date windowing
 * in JavaScript — which meant the assertions were really testing the double's
 * idea of a window, not the query's. Seeding real rows and letting SQLite do
 * the filtering is both shorter and worth more: a window that is wrong by a day
 * now fails here.
 */
export const ORG = 'org1';
export const SITE_A = 'site1';
export const SITE_B = 'site2';

export interface SafetyWorld extends TestD1 {
  drizzle: ReturnType<typeof drizzle<typeof schema>>;
  /** One man-day: a closed session for a generated worker on that date. */
  manDay(date: string, siteId?: string): Promise<void>;
  /** `{ '2026-06-01': 10, ... }` — that many man-days on each of those days. */
  manDays(days: Record<string, number>, siteId?: string): Promise<void>;
  /** A typed figure on the daily sheet. */
  entry(row: {
    metric: string;
    date: string;
    value?: number | null;
    comment?: string | null;
    siteId?: string;
  }): Promise<void>;
  /** A waste line, which the sheet totals into WASTE_DISPOSAL. */
  wasteType(id: string, name: string, sortOrder?: number): Promise<void>;
  wasteEntry(row: {
    date: string;
    wasteTypeId: string;
    value: number;
    siteId?: string;
  }): Promise<void>;
}

export async function makeSafetyWorld(
  opts: { timezone?: string } = {},
): Promise<SafetyWorld> {
  const base = await createTestD1();
  const { db } = base;
  const tz = opts.timezone ?? 'Asia/Kolkata';
  const now = 0;
  let seq = 0;

  await insert(db, 'organizations', {
    id: ORG, name: 'Optispace', code: 'OPS', timezone: tz,
    is_active: 1, logo_scale: 1, created_at: now, updated_at: now,
  });
  for (const [id, name, code] of [
    [SITE_A, 'Tower A', 'TA'],
    [SITE_B, 'Tower B', 'TB'],
  ]) {
    await insert(db, 'sites', {
      id, organization_id: ORG, name, code, timezone: tz,
      is_active: 1, created_at: now, updated_at: now,
    });
  }

  const manDay = async (date: string, siteId = SITE_A) => {
    seq += 1;
    const workerId = `w${seq}`;
    // A distinct worker per man-day: one open session per worker is a database
    // constraint, and these are closed sessions anyway, but keeping them
    // separate means a count of sessions is a count of people.
    await insert(db, 'workers', {
      id: workerId, organization_id: ORG, worker_code: `W-${seq}`,
      full_name: `Worker ${seq}`, category: 'WORKER', status: 'ACTIVE',
      created_at: now, updated_at: now,
    });
    await insert(db, 'attendance_sessions', {
      id: `s${seq}`, organization_id: ORG, worker_id: workerId, site_id: siteId,
      work_date: date, login_at: Date.parse(`${date}T03:30:00.000Z`),
      logout_at: Date.parse(`${date}T12:30:00.000Z`), worked_minutes: 540,
      state: 'CLOSED', is_cross_site: 0, created_at: now, updated_at: now,
    });
  };

  return {
    ...base,
    drizzle: drizzle(db, { schema }),
    manDay,
    async manDays(days, siteId = SITE_A) {
      for (const [date, count] of Object.entries(days)) {
        for (let i = 0; i < count; i++) await manDay(date, siteId);
      }
    },
    async entry(row) {
      seq += 1;
      await insert(db, 'daily_safety_entries', {
        id: `e${seq}`,
        organization_id: ORG,
        site_id: row.siteId ?? SITE_A,
        entry_date: row.date,
        metric: row.metric,
        value: row.value ?? null,
        comment: row.comment ?? null,
        created_at: now,
        updated_at: now,
      });
    },
    async wasteType(id, name, sortOrder = 1) {
      await insert(db, 'waste_types', {
        id, organization_id: ORG, name, sort_order: sortOrder,
        is_active: 1, created_at: now, updated_at: now,
      });
    },
    async wasteEntry(row) {
      seq += 1;
      await insert(db, 'daily_waste_entries', {
        id: `dw${seq}`,
        organization_id: ORG,
        site_id: row.siteId ?? SITE_A,
        entry_date: row.date,
        waste_type_id: row.wasteTypeId,
        value: row.value,
        created_at: now,
        updated_at: now,
      });
    },
  };
}

/** Ten man-days on every day of a month, so any window has a distinct total. */
export function evenMonth(month: string, perDay = 10): Record<string, number> {
  const days: Record<string, number> = {};
  const target = new Date(`${month}-01T00:00:00.000Z`).getUTCMonth();
  for (let d = 1; d <= 31; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    if (new Date(`${day}T00:00:00.000Z`).getUTCMonth() !== target) continue;
    days[day] = perDay;
  }
  return days;
}
