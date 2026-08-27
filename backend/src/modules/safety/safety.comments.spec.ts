import { SafetyService } from './safety.service';
import { AuthUser } from '../../common/auth/auth-user.interface';

/**
 * Comments on the daily task sheet, read back from the statistics board.
 *
 * The board's site filter opens on "All sites", and every read that spanned
 * more than one site used to drop the comment on the floor — a note can only
 * belong to one site, so the aggregate returned null. From the officer's chair
 * that reads as "I typed a comment and it was not saved", because the place
 * they go to look at it is exactly the place that threw it away.
 */

const user = {
  userId: 'u1',
  organizationId: 'org1',
  role: 'SUPER_ADMIN',
  siteScopes: [],
} as unknown as AuthUser;

interface Row {
  siteId: string;
  siteName: string;
  date: string;
  metric: string;
  value: number | null;
  comment: string | null;
}

function build(rows: Row[]) {
  const stored = rows.map((r, i) => ({
    id: `e${i}`,
    organizationId: 'org1',
    siteId: r.siteId,
    entryDate: new Date(`${r.date}T00:00:00.000Z`),
    metric: r.metric,
    value: r.value,
    comment: r.comment,
    updatedAt: new Date(),
    site: { name: r.siteName },
  }));

  const prisma: any = {
    organization: { findUnique: async () => ({ timezone: 'Asia/Kolkata' }) },
    attendanceSession: { count: async () => 0, findMany: async () => [] },
    wasteType: { count: async () => 1, findMany: async () => [] },
    dailyWasteEntry: { groupBy: async () => [] },
    dailySafetyEntry: {
      findMany: async ({ where }: any) =>
        stored.filter(
          (r) =>
            (!where.metric || r.metric === where.metric) &&
            (!where.siteId?.in || where.siteId.in.includes(r.siteId)) &&
            (!where.comment || r.comment !== null),
        ),
    },
  };

  return new SafetyService(prisma, null as never);
}

const day = '2026-06-17';

describe('safety comments across sites', () => {
  it('keeps a comment when the board is reading every site', async () => {
    const svc = build([
      {
        siteId: 's1',
        siteName: 'Tower A',
        date: day,
        metric: 'WORK_PERMIT',
        value: 3,
        comment: 'hot work 1 + general 2',
      },
    ]);

    const all = await svc.history(user, { metric: 'WORK_PERMIT' as never, from: day, to: day });

    expect(all.rows[0].value).toBe(3);
    expect(all.rows[0].comment).toBe('Tower A: hot work 1 + general 2');
  });

  it('names each site when several commented on the same day', async () => {
    const svc = build([
      {
        siteId: 's1',
        siteName: 'Tower A',
        date: day,
        metric: 'NEAR_MISS',
        value: 1,
        comment: 'slip at gate',
      },
      {
        siteId: 's2',
        siteName: 'Tower B',
        date: day,
        metric: 'NEAR_MISS',
        value: 2,
        comment: 'loose rebar',
      },
    ]);

    const all = await svc.history(user, { metric: 'NEAR_MISS' as never, from: day, to: day });

    // Summed figure, both notes kept — picking one at random would be worse
    // than saying nothing, and saying nothing is what it used to do.
    expect(all.rows[0].value).toBe(3);
    expect(all.rows[0].comment).toBe('Tower A: slip at gate · Tower B: loose rebar');
  });

  it('leaves a single-site read exactly as the officer typed it', async () => {
    const svc = build([
      {
        siteId: 's1',
        siteName: 'Tower A',
        date: day,
        metric: 'TRAINING',
        value: 1,
        comment: 'Scaffolding training',
      },
    ]);

    const one = await svc.history(user, {
      metric: 'TRAINING' as never,
      siteId: 's1',
      from: day,
      to: day,
    });

    // One site is one author, so the note needs no attribution in front of it.
    expect(one.rows[0].comment).toBe('Scaffolding training');
    expect(one.rows[0].entryId).toBe('e0');
  });

  it('says nothing for a day nobody commented on', async () => {
    const svc = build([
      { siteId: 's1', siteName: 'Tower A', date: day, metric: 'TRAINING', value: 1, comment: null },
    ]);

    const all = await svc.history(user, { metric: 'TRAINING' as never, from: day, to: day });

    expect(all.rows[0].recorded).toBe(true);
    expect(all.rows[0].comment).toBeNull();
  });
});
