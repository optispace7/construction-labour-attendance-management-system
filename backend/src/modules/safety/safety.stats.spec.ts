import { SafetyService } from './safety.service';
import { AuthUser } from '../../common/auth/auth-user.interface';

/**
 * The statistics board against the period selector.
 *
 * Switching daily → weekly → monthly used to leave the whole top row where it
 * was: the three manpower figures were counted at a single anchor date and the
 * score was always the calendar month, so the filter looked broken. These tests
 * pin each headline figure to the window it claims to cover.
 */

const user = {
  userId: 'u1',
  organizationId: 'org1',
  role: 'SUPER_ADMIN',
  siteScopes: [],
} as unknown as AuthUser;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A prisma double that answers from one set of man-days, so a count is a real
 * count of the window asked for rather than a fixture number that would pass
 * whatever window the code chose.
 */
function build(
  opts: {
    manDays?: Record<string, number>;
    entries?: { metric: string; date: string; value: number }[];
  } = {},
) {
  const manDays = opts.manDays ?? {};
  const entries = opts.entries ?? [];

  const sessionDates: string[] = [];
  for (const [day, n] of Object.entries(manDays)) {
    for (let i = 0; i < n; i++) sessionDates.push(day);
  }

  const inRange = (day: string, w: { gte?: Date; lte?: Date; lt?: Date }) => {
    if (w.gte && day < iso(w.gte)) return false;
    if (w.lte && day > iso(w.lte)) return false;
    if (w.lt && day >= iso(w.lt)) return false;
    return true;
  };

  const countCalls: { gte?: Date; lte?: Date; lt?: Date }[] = [];
  const seriesCalls: { gte?: Date; lte?: Date }[] = [];

  const prisma: any = {
    organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }) },
    site: { findFirst: jest.fn().mockResolvedValue(null) },
    attendanceSession: {
      count: jest.fn(async ({ where }: any) => {
        const w = where.workDate ?? {};
        countCalls.push(w);
        return sessionDates.filter((d) => inRange(d, w)).length;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const w = where.workDate ?? {};
        seriesCalls.push(w);
        return sessionDates
          .filter((d) => inRange(d, w))
          .map((d) => ({ workDate: new Date(`${d}T00:00:00.000Z`) }));
      }),
    },
    dailySafetyEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn(async ({ where }: any) => {
        const w = where.entryDate ?? {};
        const hits = entries.filter((e) => inRange(e.date, w));
        const sums = new Map<string, number>();
        for (const e of hits) sums.set(e.metric, (sums.get(e.metric) ?? 0) + e.value);
        return [...sums].map(([metric, value]) => ({ metric, _sum: { value } }));
      }),
    },
  };

  const svc = new SafetyService(prisma, null as never);
  return { svc, prisma, countCalls, seriesCalls };
}

/** Ten man-days on every day of a month, so any window has a distinct total. */
function evenMonth(month: string, perDay = 10) {
  const days: Record<string, number> = {};
  for (let d = 1; d <= 31; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    if (
      new Date(`${day}T00:00:00.000Z`).getUTCMonth() !==
      new Date(`${month}-01T00:00:00.000Z`).getUTCMonth()
    )
      continue;
    days[day] = perDay;
  }
  return days;
}

describe('safety stats — the period selector', () => {
  it('counts manpower over the selected window, not one anchor day', async () => {
    const manDays = evenMonth('2026-06');
    const { svc } = build({ manDays });

    // 2026-06-17 is a Wednesday, so the week is Mon 15th to Sun 21st.
    const daily = await svc.stats(user, { period: 'daily', date: '2026-06-17' });
    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });
    const monthly = await svc.stats(user, { period: 'monthly', date: '2026-06-17' });

    expect(daily.kpis.periodManpower).toBe(10);
    expect(weekly.kpis.periodManpower).toBe(70);
    expect(monthly.kpis.periodManpower).toBe(300);
  });

  it('credits safe man-hours for the same window as the manpower beside it', async () => {
    const { svc } = build({ manDays: evenMonth('2026-06') });

    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });

    expect(weekly.kpis.periodSafeManHours).toBe(weekly.kpis.periodManpower * 10);
    expect(weekly.kpis.periodSafeManHours).toBe(700);
  });

  it('keeps total manpower cumulative, read at the last day of the window', async () => {
    const { svc } = build({ manDays: { ...evenMonth('2026-05'), ...evenMonth('2026-06') } });

    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });

    // May's 310 plus the 21st of June inclusive — a running project total, not
    // the week's 70, and not today's.
    expect(weekly.kpis.totalManpower).toBe(310 + 210);
    expect(weekly.to).toBe('2026-06-21');
  });

  it('moves every headline figure when the custom range moves', async () => {
    const { svc } = build({ manDays: evenMonth('2026-06') });

    const first = await svc.stats(user, {
      period: 'custom',
      from: '2026-06-01',
      to: '2026-06-10',
    });
    const second = await svc.stats(user, {
      period: 'custom',
      from: '2026-06-11',
      to: '2026-06-20',
    });

    expect(first.kpis.periodManpower).toBe(100);
    expect(second.kpis.periodManpower).toBe(100);
    // Same length window, so manpower matches — but the running total must not.
    expect(first.kpis.totalManpower).toBe(100);
    expect(second.kpis.totalManpower).toBe(200);
  });

  it('plots the sparklines over the window rather than a fixed trailing month', async () => {
    const { svc } = build({ manDays: evenMonth('2026-06') });

    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });

    expect(weekly.manpower.days).toHaveLength(7);
    expect(weekly.manpower.days[0]).toBe('2026-06-15');
    expect(weekly.manpower.days.at(-1)).toBe('2026-06-21');
    // The safe-hours card is a period figure, so its line is per-day hours.
    expect(weekly.manpower.dailySafeManHours[0]).toBe(100);
    // The to-date card is cumulative, so its line still runs forward.
    expect(weekly.manpower.cumulative.at(-1)).toBe(210);
  });

  it('still gives a daily report a week of run-up, so the spark is a line', async () => {
    const { svc } = build({ manDays: evenMonth('2026-06') });

    const daily = await svc.stats(user, { period: 'daily', date: '2026-06-17' });

    // One point is not a line; the trend chart already widens the same way.
    expect(daily.manpower.days).toHaveLength(7);
    expect(daily.manpower.days.at(-1)).toBe('2026-06-17');
    // The card above it still reports the single day.
    expect(daily.kpis.periodManpower).toBe(10);
  });

  it('scores the selected window, not always the calendar month', async () => {
    const { svc } = build({
      manDays: evenMonth('2026-06'),
      entries: [
        // An injury outside the week must not weigh on the week's dial.
        { metric: 'LOST_TIME_INJURY', date: '2026-06-02', value: 1 },
        { metric: 'TOOLBOX_TALK', date: '2026-06-17', value: 1 },
      ],
    });

    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });
    const monthly = await svc.stats(user, { period: 'monthly', date: '2026-06-17' });

    expect(weekly.kpis.safetyPerformance).toBe(100);
    // −10 for the injury, −3 for three routine activities the month never saw.
    expect(monthly.kpis.safetyPerformance).toBe(87);
  });

  it('does not charge a short window for routine work it was too short to hold', async () => {
    const { svc } = build({
      manDays: evenMonth('2026-06'),
      entries: [{ metric: 'TOOLBOX_TALK', date: '2026-06-17', value: 1 }],
    });

    const daily = await svc.stats(user, { period: 'daily', date: '2026-06-17' });
    const monthly = await svc.stats(user, { period: 'monthly', date: '2026-06-17' });

    // A Tuesday with no training, permit or induction on it is a Tuesday, not
    // a safety failure. The month, which really did record none, is charged.
    expect(daily.kpis.safetyPerformance).toBe(100);
    expect(daily.kpis.safetyPerformanceScoredInactivity).toBe(false);
    expect(monthly.kpis.safetyPerformance).toBe(97);
    expect(monthly.kpis.safetyPerformanceScoredInactivity).toBe(true);
  });

  it('still charges a short window for what actually went wrong in it', async () => {
    const { svc } = build({
      manDays: evenMonth('2026-06'),
      entries: [
        { metric: 'LOST_TIME_INJURY', date: '2026-06-17', value: 1 },
        { metric: 'UNSAFE_ACTS', date: '2026-06-17', value: 3 },
        { metric: 'UNSAFE_ACTS_CLOSED', date: '2026-06-17', value: 1 },
      ],
    });

    const daily = await svc.stats(user, { period: 'daily', date: '2026-06-17' });

    // −10 for the injury and −2 for the two acts left open. Holding back the
    // inactivity rule must not hold back the rest of the scoring.
    expect(daily.kpis.safetyPerformance).toBe(88);
  });

  it('names the derived rows for the window they now cover', async () => {
    const { svc } = build({ manDays: evenMonth('2026-06') });

    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });
    const labels = new Map(weekly.statistics.map((s) => [s.metric, s.label]));

    // "Daily manpower" against a week's man-days is the wrong word, and it is
    // the wording the daily sheet needs — so the board renames its own copy.
    expect(labels.get('DAILY_MANPOWER')).toBe('Manpower');
    expect(labels.get('TOTAL_MANPOWER')).toBe('Total manpower to date');
    expect(labels.get('TOTAL_SAFE_MAN_HOURS')).toBe('Safe man-hours');
  });

  it('counts staff as manpower, and leaves visitors out', async () => {
    const { svc, prisma } = build({ manDays: evenMonth('2026-06') });

    await svc.stats(user, { period: 'weekly', date: '2026-06-17' });

    // An engineer standing in the same hazard is a man-day on the safety board
    // and earns the same safe hours; somebody walking through for an hour is
    // not. Asserted on the query because the board's whole headline row is
    // built from it.
    const where = prisma.attendanceSession.count.mock.calls[0][0].where;
    expect(where.worker.category).toEqual({ in: ['WORKER', 'STAFF'] });
  });
});
