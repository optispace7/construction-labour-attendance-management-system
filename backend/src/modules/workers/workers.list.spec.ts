import { drizzle } from 'drizzle-orm/d1';
import { WorkersService } from './workers.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { createTestD1, insert, TestD1 } from '../../../test/d1-harness';
import * as schema from '../../infra/d1/schema.generated';

/**
 * Paging the workers list, against a real SQLite.
 *
 * The second page is keyed on the last row's created_at, written into a raw sql
 * template. That template does not go through Drizzle's column mapping, so the
 * Date was bound as an object — which D1 refuses, and so does Node's SQLite —
 * and every "Load more" on the Workers page came back 500. A double would have
 * accepted the Date without complaint, which is why this runs on the real thing.
 */
describe('WorkersService.list paging', () => {
  const user = {
    userId: 'u1',
    organizationId: 'org1',
    role: 'SUPER_ADMIN',
    siteScopes: [],
  } as unknown as AuthUser;

  let harness: TestD1 | null = null;

  afterEach(async () => {
    await harness?.dispose();
    harness = null;
  });

  const build = async (count: number) => {
    harness = await createTestD1();
    const { db } = harness;
    await insert(db, 'organizations', {
      id: 'org1', name: 'X', code: 'X', timezone: 'UTC',
      is_active: 1, logo_scale: 1, created_at: 0, updated_at: 0,
    });
    for (let i = 1; i <= count; i++) {
      const code = `W-${String(i).padStart(4, '0')}`;
      await insert(db, 'workers', {
        id: `w${i}`,
        organization_id: 'org1',
        worker_code: code,
        full_name: `Worker ${String.fromCharCode(64 + i)}`,
        category: 'WORKER',
        status: 'ACTIVE',
        // A different time each, a day apart, so newest-first is unambiguous.
        created_at: Date.UTC(2026, 7, i),
        updated_at: 0,
      });
    }
    return new WorkersService(
      { db: drizzle(db, { schema }), d1: db } as never,
      {} as never,
      { record: jest.fn() } as never,
    );
  };

  /** Every page, in order, as the panel's Load more would ask for them. */
  const allPages = async (svc: WorkersService, opts: { sortBy?: string } = {}) => {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await svc.list(user, { category: 'WORKER', limit: 2, cursor, ...opts });
      pages.push(page.data.map((w) => w.workerCode));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  };

  it('loads the next page after the first, newest first, with nobody twice', async () => {
    const svc = await build(5);

    const pages = await allPages(svc);

    expect(pages).toEqual([['W-0005', 'W-0004'], ['W-0003', 'W-0002'], ['W-0001']]);
  });

  it('pages by name too', async () => {
    const svc = await build(3);

    const pages = await allPages(svc, { sortBy: 'name' });

    expect(pages).toEqual([['W-0001', 'W-0002'], ['W-0003']]);
  });
});
