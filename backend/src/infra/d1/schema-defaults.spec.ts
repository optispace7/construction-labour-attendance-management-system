import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { createTestD1 } from '../../../test/d1-harness';
import * as schema from './schema.generated';
import { attendanceSessions, designations, vendors, workers } from './schema.generated';

/**
 * Columns the application does not set, and expects the schema to fill in.
 *
 * The Prisma schema gave 46 columns a default. The generator that produced the
 * Drizzle schema emitted `.notNull()` and dropped every one of them, and the
 * migration built from the same output gave D1's tables no DEFAULT clause
 * either. Nothing failed at build time and no existing row noticed, because
 * every row in the database had been written with a value already.
 *
 * It surfaced the first time somebody added a vendor: the insert omits
 * is_active, SQLite refused it, and the panel showed "Internal server error"
 * with no hint of which column or which table.
 *
 * So this asserts the behaviour rather than the declaration — an insert that
 * leaves a defaulted column out has to land, and land with the value the old
 * database would have written. Run against the real migration, so a schema
 * that drifts from D1 fails here.
 */
describe('columns that default themselves', () => {
  const open = async () => {
    const t = await createTestD1();
    return { t, db: drizzle(t.db, { schema }) };
  };

  it('fills in a vendor is_active, which is what adding a vendor omits', async () => {
    const { t, db } = await open();
    const now = new Date();
    await db.insert(vendors).values({
      id: 'v1',
      organizationId: 'org1',
      name: 'Acme Labour',
      code: 'ACME',
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(vendors).where(eq(vendors.id, 'v1'));
    expect(row.isActive).toBe(true);
    await t.dispose();
  });

  it('fills in a designation is_active', async () => {
    const { t, db } = await open();
    const now = new Date();
    await db.insert(designations).values({
      id: 'd1',
      organizationId: 'org1',
      name: 'Mason',
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db.select().from(designations).where(eq(designations.id, 'd1'));
    expect(row.isActive).toBe(true);
    await t.dispose();
  });

  it('fills in the enum defaults a worker and a session rely on', async () => {
    const { t, db } = await open();
    const now = new Date();
    await db.insert(workers).values({
      id: 'w1',
      organizationId: 'org1',
      workerCode: 'W-0001',
      fullName: 'A Worker',
      createdAt: now,
      updatedAt: now,
    });
    const [worker] = await db.select().from(workers).where(eq(workers.id, 'w1'));
    expect(worker.category).toBe('WORKER');
    expect(worker.status).toBe('ACTIVE');

    await db.insert(attendanceSessions).values({
      id: 's1',
      organizationId: 'org1',
      siteId: 'site1',
      workerId: 'w1',
      workDate: '2026-09-11',
      loginAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const [session] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, 's1'));
    expect(session.state).toBe('OPEN');
    expect(session.isCrossSite).toBe(false);
    await t.dispose();
  });

  /**
   * The guard against the original mistake coming back wholesale. Every column
   * that is NOT NULL and carries no default has to be one the application
   * always supplies; a new one appearing here means an insert somewhere is one
   * regeneration away from failing the way vendors did.
   */
  it('leaves no NOT NULL column without either a default or a writer', () => {
    const tables = (Object.values(schema) as unknown[]).filter(
      (t) => typeof t === 'object' && t !== null,
    ) as Record<string, unknown>[];
    const undefended: string[] = [];
    for (const table of tables) {
      for (const [name, col] of Object.entries(table)) {
        const c = col as { notNull?: boolean; hasDefault?: boolean; name?: string };
        if (!c || typeof c !== 'object' || c.notNull === undefined) continue;
        if (c.notNull && !c.hasDefault) undefended.push(`${c.name ?? name}`);
      }
    }
    // Ids, foreign keys and timestamps are always written by the caller; what
    // must not appear is a flag or a status, which is what was lost before.
    //
    // Two are deliberate, and were never defaulted in Postgres either. A
    // credential's kind says whether it is an NFC card or a QR code, and a sync
    // event's status says what became of the tap — accepted, duplicate,
    // conflict, rejected. Each is the reason its row exists, so a default would
    // be a wrong answer rather than a convenient one.
    const allowed = new Set(['kind', 'status']);
    const suspicious = undefended.filter(
      (n) => /^(is_|has_|can_|auto_|status|state|category|kind|mode)/.test(n) && !allowed.has(n),
    );
    expect(suspicious).toEqual([]);
  });
});
