import { SafetyService } from './safety.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { evenMonth, makeSafetyWorld, SafetyWorld } from '../../../test/safety-fixtures';

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

let world: SafetyWorld | null = null;

afterEach(async () => {
  await world?.dispose();
  world = null;
});

/**
 * The service over a real database, holding the man-days and typed figures the
 * test names. The windows are then SQLite's to apply, which is the thing being
 * asserted — a double that re-implemented them could only agree with itself.
 */
async function build(
  opts: {
    manDays?: Record<string, number>;
    entries?: { metric: string; date: string; value: number }[];
  } = {},
) {
  world = await makeSafetyWorld();
  await world.manDays(opts.manDays ?? {});
  for (const e of opts.entries ?? []) await world.entry(e);
  const svc = new SafetyService(
    { db: world.drizzle, d1: world.db } as never,
    null as never,
  );
  return { svc, world };
}

describe('safety stats — the period selector', () => {
  it('counts manpower over the selected window, not one anchor day', async () => {
    const { svc } = await build({ manDays: evenMonth('2026-06') });

    // 2026-06-17 is a Wednesday, so the week is Mon 15th to Sun 21st.
    const daily = await svc.stats(user, { period: 'daily', date: '2026-06-17' });
    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });
    const monthly = await svc.stats(user, { period: 'monthly', date: '2026-06-17' });

    expect(daily.kpis.periodManpower).toBe(10);
    expect(weekly.kpis.periodManpower).toBe(70);
    expect(monthly.kpis.periodManpower).toBe(300);
  });

  it('credits safe man-hours for the same window as the manpower beside it', async () => {
    const { svc } = await build({ manDays: evenMonth('2026-06') });

    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });

    expect(weekly.kpis.periodSafeManHours).toBe(weekly.kpis.periodManpower * 10);
    expect(weekly.kpis.periodSafeManHours).toBe(700);
  });

  it('keeps total manpower cumulative, read at the last day of the window', async () => {
    const { svc } = await build({ manDays: { ...evenMonth('2026-05'), ...evenMonth('2026-06') } });

    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });

    // May's 310 plus the 21st of June inclusive — a running project total, not
    // the week's 70, and not today's.
    expect(weekly.kpis.totalManpower).toBe(310 + 210);
    expect(weekly.to).toBe('2026-06-21');
  });

  it('moves every headline figure when the custom range moves', async () => {
    const { svc } = await build({ manDays: evenMonth('2026-06') });

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
    const { svc } = await build({ manDays: evenMonth('2026-06') });

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
    const { svc } = await build({ manDays: evenMonth('2026-06') });

    const daily = await svc.stats(user, { period: 'daily', date: '2026-06-17' });

    // One point is not a line; the trend chart already widens the same way.
    expect(daily.manpower.days).toHaveLength(7);
    expect(daily.manpower.days.at(-1)).toBe('2026-06-17');
    // The card above it still reports the single day.
    expect(daily.kpis.periodManpower).toBe(10);
  });

  it('scores the selected window, not always the calendar month', async () => {
    const { svc } = await build({
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
    const { svc } = await build({
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
    const { svc } = await build({
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
    const { svc } = await build({ manDays: evenMonth('2026-06') });

    const weekly = await svc.stats(user, { period: 'weekly', date: '2026-06-17' });
    const labels = new Map(weekly.statistics.map((s) => [s.metric, s.label]));

    // "Daily manpower" against a week's man-days is the wrong word, and it is
    // the wording the daily sheet needs — so the board renames its own copy.
    expect(labels.get('DAILY_MANPOWER')).toBe('Manpower');
    expect(labels.get('TOTAL_MANPOWER')).toBe('Total manpower to date');
    expect(labels.get('TOTAL_SAFE_MAN_HOURS')).toBe('Safe man-hours');
  });

  it('counts staff as manpower, and leaves visitors out', async () => {
    // An engineer standing in the same hazard is a man-day on the safety board
    // and earns the same safe hours; somebody walking through for an hour is
    // not.
    const { svc, world } = await build({});
    const w = world;
    await w.manDay('2026-06-17'); // a WORKER
    await w.db
      .prepare("update workers set category = 'STAFF' where id = (select max(id) from workers)")
      .run();
    await w.manDay('2026-06-17'); // another WORKER
    await w.manDay('2026-06-17');
    await w.db
      .prepare("update workers set category = 'VISITOR' where id = (select max(id) from workers)")
      .run();

    const daily = await svc.stats(user, { period: 'daily', date: '2026-06-17' });

    // Two of the three count: the staff member and the worker. The visitor
    // does not.
    expect(daily.kpis.periodManpower).toBe(2);
  });
});
