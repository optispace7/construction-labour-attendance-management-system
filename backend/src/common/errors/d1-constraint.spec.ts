import { drizzle } from 'drizzle-orm/d1';
import { createTestD1 } from '../../../test/d1-harness';
import * as schema from '../../infra/d1/schema.generated';
import { vendors } from '../../infra/d1/schema.generated';
import { constraintFailure } from './d1-constraint';

/**
 * Adding a vendor with a code another vendor already had returned "Internal
 * server error", twice, with nothing on screen to say which field was the
 * problem. The database had said so plainly and the message stopped at the log.
 *
 * The error is raised by SQLite and wrapped by Drizzle, so these go through a
 * real insert rather than a hand-written message: a string that is close but
 * not exact would pass a test and fail in production.
 */
describe('constraint failures', () => {
  const seed = async () => {
    const t = await createTestD1();
    const db = drizzle(t.db, { schema });
    const now = new Date();
    await db.insert(vendors).values({
      id: 'v1',
      organizationId: 'org1',
      name: 'Bipin carpet',
      code: 'v9',
      createdAt: now,
      updatedAt: now,
    });
    return { t, db, now };
  };

  it('names the field when a vendor code is taken', async () => {
    const { t, db, now } = await seed();
    let caught: unknown;
    try {
      await db.insert(vendors).values({
        id: 'v2',
        organizationId: 'org1',
        name: 'Rohit Housekeeping',
        code: 'v9',
        createdAt: now,
        updatedAt: now,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();

    const mapped = constraintFailure(caught);
    expect(mapped).not.toBeNull();
    expect(mapped!.getStatus()).toBe(409);
    expect(mapped!.code).toBe('DUPLICATE');
    expect(mapped!.detail).toContain('code');
    expect(mapped!.detail).toContain('vendor');
    // The organization is how the key is scoped, not something to retype.
    expect(mapped!.detail).not.toContain('organization');
    await t.dispose();
  });

  it('lets the same code through for a different organization', async () => {
    const { t, db, now } = await seed();
    await db.insert(vendors).values({
      id: 'v3',
      organizationId: 'org2',
      name: 'Someone else',
      code: 'v9',
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db.select().from(vendors);
    expect(rows).toHaveLength(2);
    await t.dispose();
  });

  it('leaves anything that is not a constraint failure alone', () => {
    expect(constraintFailure(new Error('boom'))).toBeNull();
    expect(constraintFailure(undefined)).toBeNull();
  });

  it('reads the message through a wrapper, the way Drizzle raises it', () => {
    const inner = new Error('UNIQUE constraint failed: workers.organization_id, workers.worker_code');
    const outer = new Error('Failed query: insert into "workers" ...', { cause: inner });
    const mapped = constraintFailure(outer);
    expect(mapped!.code).toBe('DUPLICATE');
    expect(mapped!.detail).toContain('worker code');
  });
});
