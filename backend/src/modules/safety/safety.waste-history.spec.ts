import { SafetyService } from './safety.service';
import { AuthUser } from '../../common/auth/auth-user.interface';

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

const iso = (d: Date) => d.toISOString().slice(0, 10);

function build(
  waste: { typeId: string; date: string; value: number }[],
  types: { id: string; name: string; sortOrder: number }[],
) {
  const prisma: any = {
    organization: { findUnique: async () => ({ timezone: 'Asia/Kolkata' }) },
    attendanceSession: { count: async () => 0, findMany: async () => [] },
    dailySafetyEntry: {
      findMany: async () => [
        {
          id: 'e0',
          organizationId: 'org1',
          siteId: 's1',
          entryDate: new Date('2026-08-27T00:00:00.000Z'),
          metric: 'WASTE_DISPOSAL',
          value: 3,
          comment: 'test',
          site: { name: 'Tower A' },
        },
      ],
    },
    wasteType: {
      findMany: async ({ where }: any) =>
        types.filter((t) => !where?.id?.in || where.id.in.includes(t.id)),
    },
    dailyWasteEntry: {
      groupBy: async ({ where }: any) => {
        const w = where.entryDate ?? {};
        const hits = waste.filter(
          (r) => (!w.gte || r.date >= iso(w.gte)) && (!w.lte || r.date <= iso(w.lte)),
        );
        const sums = new Map<string, number>();
        for (const r of hits) {
          sums.set(`${r.date}|${r.typeId}`, (sums.get(`${r.date}|${r.typeId}`) ?? 0) + r.value);
        }
        return [...sums].map(([k, value]) => {
          const [date, wasteTypeId] = k.split('|');
          return {
            entryDate: new Date(`${date}T00:00:00.000Z`),
            wasteTypeId,
            _sum: { value },
          };
        });
      },
    },
  };
  return new SafetyService(prisma, null as never);
}

const TYPES = [
  { id: 't2', name: 'Gypsum Waste', sortOrder: 2 },
  { id: 't1', name: 'Civil / Block Waste', sortOrder: 1 },
];
const day = '2026-08-27';

describe('waste disposal history', () => {
  it('carries the split the total was made of', async () => {
    const svc = build(
      [
        { typeId: 't1', date: day, value: 1 },
        { typeId: 't2', date: day, value: 2 },
      ],
      TYPES,
    );

    const h = await svc.history(user, {
      metric: 'WASTE_DISPOSAL' as never,
      siteId: 's1',
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
    const svc = build([], TYPES);

    const h = await svc.history(user, {
      metric: 'TOOLBOX_TALK' as never,
      siteId: 's1',
      from: day,
      to: day,
    });

    // Nothing underneath a typed number, and the drawer draws no panel for it.
    expect(h.rows[0].breakdown).toBeNull();
  });

  it('says nothing for a day inside the window with no waste on it', async () => {
    const svc = build([{ typeId: 't1', date: '2026-08-26', value: 4 }], TYPES);

    const h = await svc.history(user, {
      metric: 'WASTE_DISPOSAL' as never,
      siteId: 's1',
      from: '2026-08-26',
      to: day,
    });

    expect(h.rows[0].breakdown).toEqual([{ label: 'Civil / Block Waste', value: 4 }]);
    expect(h.rows[1].breakdown).toBeNull();
  });
});
