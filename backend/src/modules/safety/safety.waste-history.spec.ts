import { SafetyService } from './safety.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { makeSafetyWorld, SafetyWorld, SITE_A } from '../../../test/safety-fixtures';

/**
 * The day-by-day drawer for waste disposal.
 *
 * Its figure is the total of the lines the officer typed, and the drawer used
 * to show only that total: a day split one skip of block waste and two of
 * gypsum read back as "3 recorded" and nothing else. The split travels with the
 * history now, so the panel can show what the number is made of.
 */

const user = {
  userId: 'u1',
  organizationId: 'org1',
  role: 'SUPER_ADMIN',
  siteScopes: [],
} as unknown as AuthUser;

let world: SafetyWorld | null = null;

afterEach(async () => {
  await world?.dispose();
  world = null;
});

/**
 * The service over a real database holding the waste lines the test names,
 * plus the WASTE_DISPOSAL row those lines total into — which is what the
 * daily sheet writes and what the drawer reads.
 */
async function build(
  waste: { typeId: string; date: string; value: number }[],
  types: { id: string; name: string; sortOrder: number }[],
) {
  world = await makeSafetyWorld();
  for (const t of types) await world.wasteType(t.id, t.name, t.sortOrder);
  for (const w of waste) {
    await world.wasteEntry({ date: w.date, wasteTypeId: w.typeId, value: w.value });
  }
  // The sheet's own row for the day under test, as saveWaste would have left it.
  await world.entry({ metric: 'WASTE_DISPOSAL', date: day, value: 3, comment: 'test' });
  await world.entry({ metric: 'TOOLBOX_TALK', date: day, value: 1 });
  return new SafetyService({ db: world.drizzle, d1: world.db } as never, null as never);
}

const TYPES = [
  { id: 't2', name: 'Gypsum Waste', sortOrder: 2 },
  { id: 't1', name: 'Civil / Block Waste', sortOrder: 1 },
];
const day = '2026-08-27';

describe('waste disposal history', () => {
  it('carries the split the total was made of', async () => {
    const svc = await build(
      [
        { typeId: 't1', date: day, value: 1 },
        { typeId: 't2', date: day, value: 2 },
      ],
      TYPES,
    );

    const h = await svc.history(user, {
      metric: 'WASTE_DISPOSAL' as never,
      siteId: SITE_A,
      from: day,
      to: day,
    });

    expect(h.rows[0].value).toBe(3);
    // The dropdown's order, not the order the rows came back in.
    expect(h.rows[0].breakdown).toEqual([
      { label: 'Civil / Block Waste', value: 1 },
      { label: 'Gypsum Waste', value: 2 },
    ]);
    // And the note the officer typed beside it.
    expect(h.rows[0].comment).toBe('test');
  });

  it('leaves a metric that is not a total of anything without a breakdown', async () => {
    const svc = await build([], TYPES);

    const h = await svc.history(user, {
      metric: 'TOOLBOX_TALK' as never,
      siteId: SITE_A,
      from: day,
      to: day,
    });

    // Nothing underneath a typed number, and the drawer draws no panel for it.
    expect(h.rows[0].breakdown).toBeNull();
  });

  it('says nothing for a day inside the window with no waste on it', async () => {
    const svc = await build([{ typeId: 't1', date: '2026-08-26', value: 4 }], TYPES);
    await world!.entry({ metric: 'WASTE_DISPOSAL', date: '2026-08-26', value: 4 });

    const h = await svc.history(user, {
      metric: 'WASTE_DISPOSAL' as never,
      siteId: SITE_A,
      from: '2026-08-26',
      to: day,
    });

    expect(h.rows[0].breakdown).toEqual([{ label: 'Civil / Block Waste', value: 4 }]);
    expect(h.rows[1].breakdown).toBeNull();
  });
});
