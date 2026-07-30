import { Injectable } from '@nestjs/common';
import { Prisma, SafetyMetric } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { businessDate } from '../../common/time/time.util';
import {
  METRIC_CATALOG,
  SAFETY_PERFORMANCE_TARGET,
  SAFE_MAN_HOURS_PER_DAY,
  isAutomated,
  safetyPerformance,
  safetyWindow,
  specFor,
} from './safety.metrics';
import { SafetyPeriod, SaveDailyDto, UpsertMetricDto } from './dto/safety.dto';
import { renderSafetyPdf } from '../reports/report.renderer';

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const midnight = (v: string) => new Date(`${v.slice(0, 10)}T00:00:00.000Z`);

@Injectable()
export class SafetyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The org's today, in its own timezone. */
  private async today(user: AuthUser): Promise<Date> {
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { timezone: true },
    });
    return businessDate(new Date(), org?.timezone ?? 'Asia/Kolkata');
  }

  /**
   * Which sites a read may cover. `siteId` narrows to one; otherwise it is every
   * site the caller is scoped to, which is what the "All sites" filter means.
   *
   * Returns null for "no restriction" so a Super Admin with no scopes is not
   * accidentally filtered down to an empty list.
   */
  private readScope(user: AuthUser, siteId?: string): string[] | null {
    const scoped = user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0;
    if (siteId && siteId !== 'all') {
      if (scoped && !user.siteScopes.includes(siteId)) {
        throw Errors.forbidden('That site is outside your access');
      }
      return [siteId];
    }
    return scoped ? user.siteScopes : null;
  }

  /**
   * A write always names one site. There is no company-wide row to write to:
   * the figures belong to a site and the totals are an aggregation over them, so
   * "All sites" is a reading position, never a writing one.
   */
  private async writeSite(user: AuthUser, siteId: string): Promise<string> {
    if (!siteId || siteId === 'all') {
      throw Errors.validation({ message: 'Pick a site before saving safety figures' });
    }
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!site) throw Errors.notFound('Site');
    if (user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0) {
      if (!user.siteScopes.includes(siteId)) {
        throw Errors.forbidden('That site is outside your access');
      }
    }
    return site.id;
  }

  private sessionWhere(user: AuthUser, sites: string[] | null): Prisma.AttendanceSessionWhereInput {
    return {
      organizationId: user.organizationId,
      state: { not: 'VOID' },
      // Manpower means labour, the same as it does on the manpower report — a
      // visitor walking the site is not a man-day and must not earn safe hours.
      worker: { category: 'WORKER' },
      ...(sites ? { siteId: { in: sites } } : {}),
    };
  }

  /**
   * The three figures nobody types in.
   *
   * `dailyManpower` is that date's man-days. `totalManpower` is every man-day up
   * to and including it — cumulative since the project began, which is why it
   * dwarfs the daily number. Safe man-hours is that total at a flat shift length,
   * and does NOT reset on a lost-time injury: the client asked for the running
   * total, not the since-last-incident streak.
   */
  private async automated(user: AuthUser, sites: string[] | null, date: Date) {
    const where = this.sessionWhere(user, sites);
    const [dailyManpower, totalManpower] = await Promise.all([
      this.prisma.attendanceSession.count({ where: { ...where, workDate: date } }),
      this.prisma.attendanceSession.count({ where: { ...where, workDate: { lte: date } } }),
    ]);
    return {
      DAILY_MANPOWER: dailyManpower,
      TOTAL_MANPOWER: totalManpower,
      TOTAL_SAFE_MAN_HOURS: totalManpower * SAFE_MAN_HOURS_PER_DAY,
    } satisfies Partial<Record<SafetyMetric, number>>;
  }

  /**
   * One day's board: every metric in the catalogue, with the derived ones filled
   * in and the typed ones carrying whatever has been entered so far.
   *
   * Always returns the full catalogue, including metrics with no row yet — the
   * form is driven by this response, and a missing metric would otherwise be an
   * un-fillable gap. `value: null` on a manual metric means "not filled in",
   * which the stats page treats differently from a recorded zero.
   */
  async daily(user: AuthUser, opts: { date?: string; siteId?: string }) {
    const sites = this.readScope(user, opts.siteId);
    const date = opts.date ? midnight(opts.date) : await this.today(user);
    const single = opts.siteId && opts.siteId !== 'all' ? opts.siteId : null;

    const [rows, derived] = await Promise.all([
      this.prisma.dailySafetyEntry.findMany({
        where: {
          organizationId: user.organizationId,
          entryDate: date,
          ...(sites ? { siteId: { in: sites } } : {}),
        },
      }),
      this.automated(user, sites, date),
    ]);

    // Across several sites a typed metric is the sum of them, and a comment can
    // only sensibly belong to one site, so it is dropped from the aggregate view.
    const summed = new Map<SafetyMetric, number>();
    const byMetric = new Map<SafetyMetric, (typeof rows)[number]>();
    for (const r of rows) {
      if (r.value != null) summed.set(r.metric, (summed.get(r.metric) ?? 0) + r.value);
      if (single) byMetric.set(r.metric, r);
    }

    const items = METRIC_CATALOG.map((spec) => {
      const row = byMetric.get(spec.metric);
      const automatedValue = derived[spec.metric as keyof typeof derived];
      return {
        metric: spec.metric,
        label: spec.label,
        kind: spec.kind,
        group: spec.group,
        value: spec.kind === 'AUTOMATED' ? automatedValue : (summed.get(spec.metric) ?? null),
        comment: row?.comment ?? null,
        entryId: row?.id ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });

    return {
      date: iso(date),
      siteId: opts.siteId ?? 'all',
      /** Comments and per-item editing need one site; the aggregate is read-only. */
      editable: Boolean(single),
      items,
    };
  }

  /** Upsert a whole day in one go — what the form's Save button posts. */
  async saveDaily(user: AuthUser, dto: SaveDailyDto) {
    const siteId = await this.writeSite(user, dto.siteId);
    const date = midnight(dto.date);

    const writes = dto.items.map((item) =>
      this.upsertOne(user, siteId, date, {
        metric: item.metric,
        // A derived metric stores only its comment; its number comes from
        // attendance and caching it here would let the two drift apart.
        value: isAutomated(item.metric) ? null : (item.value ?? null),
        comment: item.comment ?? null,
      }),
    );
    await this.prisma.$transaction(writes);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SAFETY_DAILY_SAVE',
      entityType: 'DailySafetyEntry',
      entityId: null,
      newValue: { siteId, date: iso(date), metrics: dto.items.length },
      reason: 'Daily safety figures',
    });

    return this.daily(user, { date: iso(date), siteId });
  }

  private upsertOne(
    user: AuthUser,
    siteId: string,
    date: Date,
    data: { metric: SafetyMetric; value: number | null; comment: string | null },
  ) {
    return this.prisma.dailySafetyEntry.upsert({
      where: { siteId_entryDate_metric: { siteId, entryDate: date, metric: data.metric } },
      create: {
        organizationId: user.organizationId,
        siteId,
        entryDate: date,
        metric: data.metric,
        value: data.value,
        comment: data.comment,
        recordedById: user.userId,
      },
      update: { value: data.value, comment: data.comment, recordedById: user.userId },
    });
  }

  /** Edit a single item — the per-row Edit action. */
  async upsertMetric(user: AuthUser, dto: UpsertMetricDto) {
    const siteId = await this.writeSite(user, dto.siteId);
    const date = midnight(dto.date);
    if (!specFor(dto.metric)) throw Errors.validation({ message: 'Unknown safety metric' });

    await this.upsertOne(user, siteId, date, {
      metric: dto.metric,
      value: isAutomated(dto.metric) ? null : (dto.value ?? null),
      comment: dto.comment ?? null,
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SAFETY_METRIC_EDIT',
      entityType: 'DailySafetyEntry',
      entityId: null,
      newValue: { siteId, date: iso(date), metric: dto.metric, value: dto.value ?? null },
      reason: 'Safety figure edited',
    });
    return this.daily(user, { date: iso(date), siteId });
  }

  /**
   * Remove a single item, putting it back to "not filled in".
   *
   * A derived metric cannot be deleted as a number — only its comment goes, and
   * the figure keeps coming from attendance.
   */
  async deleteMetric(user: AuthUser, opts: { siteId: string; date: string; metric: SafetyMetric }) {
    const siteId = await this.writeSite(user, opts.siteId);
    const date = midnight(opts.date);
    const existing = await this.prisma.dailySafetyEntry.findUnique({
      where: { siteId_entryDate_metric: { siteId, entryDate: date, metric: opts.metric } },
    });
    if (!existing) throw Errors.notFound('Safety entry');

    await this.prisma.dailySafetyEntry.delete({ where: { id: existing.id } });
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'SAFETY_METRIC_DELETE',
      entityType: 'DailySafetyEntry',
      entityId: existing.id,
      oldValue: { metric: existing.metric, value: existing.value, comment: existing.comment },
      reason: 'Safety figure removed',
    });
    return this.daily(user, { date: iso(date), siteId });
  }

  /**
   * One metric across many dates — the per-item "View for all the dates".
   *
   * Derived metrics are answered from attendance for every day in the window, so
   * the history of manpower reads the same way as the history of toolbox talks.
   */
  async history(
    user: AuthUser,
    opts: { metric: SafetyMetric; siteId?: string; from?: string; to?: string },
  ) {
    const spec = specFor(opts.metric);
    if (!spec) throw Errors.validation({ message: 'Unknown safety metric' });
    const sites = this.readScope(user, opts.siteId);
    const end = opts.to ? midnight(opts.to) : await this.today(user);
    const start = opts.from ? midnight(opts.from) : new Date(end.getTime() - 29 * DAY_MS);
    if (start > end) throw Errors.validation({ message: 'The range starts after it ends' });

    const days: string[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) days.push(iso(new Date(t)));

    if (spec.kind === 'AUTOMATED') {
      const sessions = await this.prisma.attendanceSession.findMany({
        where: { ...this.sessionWhere(user, sites), workDate: { gte: start, lte: end } },
        select: { workDate: true },
      });
      const perDay = new Map<string, number>();
      for (const s of sessions) perDay.set(iso(s.workDate), (perDay.get(iso(s.workDate)) ?? 0) + 1);
      // Cumulative metrics need the running total from before the window opened.
      const priorTotal =
        spec.metric === 'DAILY_MANPOWER'
          ? 0
          : await this.prisma.attendanceSession.count({
              where: { ...this.sessionWhere(user, sites), workDate: { lt: start } },
            });
      let running = priorTotal;
      const comments = await this.commentsFor(user, opts.metric, sites, start, end);
      return {
        metric: opts.metric,
        label: spec.label,
        kind: spec.kind,
        rows: days.map((d) => {
          const dayCount = perDay.get(d) ?? 0;
          running += dayCount;
          const value =
            spec.metric === 'DAILY_MANPOWER'
              ? dayCount
              : spec.metric === 'TOTAL_MANPOWER'
                ? running
                : running * SAFE_MAN_HOURS_PER_DAY;
          return {
            date: d,
            value,
            comment: comments.get(d) ?? null,
            entryId: null,
            // A derived figure exists for every day by definition.
            recorded: true,
          };
        }),
      };
    }

    const rows = await this.prisma.dailySafetyEntry.findMany({
      where: {
        organizationId: user.organizationId,
        metric: opts.metric,
        entryDate: { gte: start, lte: end },
        ...(sites ? { siteId: { in: sites } } : {}),
      },
      orderBy: { entryDate: 'asc' },
    });
    const single = opts.siteId && opts.siteId !== 'all';
    const perDay = new Map<string, { value: number | null; comment: string | null; id: string }>();
    for (const r of rows) {
      const key = iso(r.entryDate);
      const prev = perDay.get(key);
      perDay.set(key, {
        value: (prev?.value ?? 0) + (r.value ?? 0),
        comment: single ? r.comment : null,
        id: r.id,
      });
    }
    return {
      metric: opts.metric,
      label: spec.label,
      kind: spec.kind,
      /**
       * Every day in the window, recorded or not.
       *
       * The detail drawer steps through dates and plots a continuous trend, so
       * it needs the gaps as gaps rather than as missing rows it would have to
       * infer. `recorded: false` is what lets it say "not filled in" instead of
       * printing a zero nobody entered — callers that only want the entries
       * filter on that flag.
       */
      rows: days.map((d) => {
        const hit = perDay.get(d);
        return {
          date: d,
          value: hit?.value ?? null,
          comment: hit?.comment ?? null,
          entryId: single ? (hit?.id ?? null) : null,
          recorded: Boolean(hit),
        };
      }),
    };
  }

  /** Comments attached to a derived metric, which has no stored value. */
  private async commentsFor(
    user: AuthUser,
    metric: SafetyMetric,
    sites: string[] | null,
    start: Date,
    end: Date,
  ) {
    const rows = await this.prisma.dailySafetyEntry.findMany({
      where: {
        organizationId: user.organizationId,
        metric,
        entryDate: { gte: start, lte: end },
        comment: { not: null },
        ...(sites ? { siteId: { in: sites } } : {}),
      },
      select: { entryDate: true, comment: true },
    });
    return new Map(rows.map((r) => [iso(r.entryDate), r.comment]));
  }

  /** Sum of every typed metric over a date window. */
  private async totalsOver(user: AuthUser, sites: string[] | null, start: Date, end: Date) {
    const grouped = await this.prisma.dailySafetyEntry.groupBy({
      by: ['metric'],
      where: {
        organizationId: user.organizationId,
        entryDate: { gte: start, lte: end },
        ...(sites ? { siteId: { in: sites } } : {}),
      },
      _sum: { value: true },
    });
    const out: Partial<Record<SafetyMetric, number>> = {};
    for (const g of grouped) out[g.metric] = g._sum.value ?? 0;
    return out;
  }

  /**
   * Everything the statistics board shows, for one period and one site filter.
   *
   * The headline figures are always "as of" the anchor date rather than summed
   * over the period: a cumulative man-hour total has no meaning added up across
   * a month, and today's manpower is a snapshot by definition.
   */
  async stats(user: AuthUser, opts: { period?: SafetyPeriod; date?: string; siteId?: string }) {
    const period = opts.period ?? 'daily';
    const sites = this.readScope(user, opts.siteId);
    const anchor = opts.date ? midnight(opts.date) : await this.today(user);
    const { start, end } = safetyWindow(period, anchor);

    const [derived, totals, trend, siteName] = await Promise.all([
      this.automated(user, sites, anchor),
      this.totalsOver(user, sites, start, end),
      this.trendOver(user, sites, start, end),
      opts.siteId && opts.siteId !== 'all'
        ? this.prisma.site
            .findFirst({
              where: { id: opts.siteId, organizationId: user.organizationId },
              select: { name: true },
            })
            .then((s) => s?.name ?? null)
        : Promise.resolve(null),
    ]);

    // The observations bars compare the three windows against each other, so all
    // three are needed whichever period is selected.
    const [dailyW, weeklyW, monthlyW] = (['daily', 'weekly', 'monthly'] as SafetyPeriod[]).map(
      (p) => safetyWindow(p, anchor),
    );
    const [dTot, wTot, mTot] = await Promise.all([
      this.totalsOver(user, sites, dailyW.start, dailyW.end),
      this.totalsOver(user, sites, weeklyW.start, weeklyW.end),
      this.totalsOver(user, sites, monthlyW.start, monthlyW.end),
    ]);

    const n = (t: Partial<Record<SafetyMetric, number>>, m: SafetyMetric) => t[m] ?? 0;
    const raised = (t: Partial<Record<SafetyMetric, number>>) =>
      n(t, 'UNSAFE_ACTS') + n(t, 'UNSAFE_CONDITIONS') + n(t, 'SAFETY_OBSERVATION');
    const closed = (t: Partial<Record<SafetyMetric, number>>) =>
      n(t, 'UNSAFE_ACTS_CLOSED') +
      n(t, 'UNSAFE_CONDITIONS_CLOSED') +
      n(t, 'SAFETY_OBSERVATION_CLOSED');

    const breakup = [
      { key: 'UNSAFE_ACTS', label: 'Unsafe acts', value: n(totals, 'UNSAFE_ACTS') },
      {
        key: 'UNSAFE_CONDITIONS',
        label: 'Unsafe conditions',
        value: n(totals, 'UNSAFE_CONDITIONS'),
      },
      { key: 'NEAR_MISS', label: 'Near misses', value: n(totals, 'NEAR_MISS') },
      {
        key: 'LOST_TIME_INJURY',
        label: 'Lost time injuries',
        value: n(totals, 'LOST_TIME_INJURY'),
      },
    ];
    const breakupTotal = breakup.reduce((a, b) => a + b.value, 0);

    return {
      period,
      date: iso(anchor),
      from: iso(start),
      to: iso(end),
      siteId: opts.siteId ?? 'all',
      siteName,
      kpis: {
        dailyManpower: derived.DAILY_MANPOWER,
        totalManpower: derived.TOTAL_MANPOWER,
        totalSafeManHours: derived.TOTAL_SAFE_MAN_HOURS,
        safetyPerformance: safetyPerformance(mTot),
        safetyPerformanceTarget: SAFETY_PERFORMANCE_TARGET,
      },
      trend,
      // The donut: activity that is counted rather than found.
      summary: [
        { key: 'WORK_PERMIT', label: 'Work permit', value: n(totals, 'WORK_PERMIT') },
        { key: 'TRAINING', label: 'Total training', value: n(totals, 'TRAINING') },
        { key: 'WASTE_DISPOSAL', label: 'Waste disposal', value: n(totals, 'WASTE_DISPOSAL') },
        {
          key: 'VISITOR_INDUCTION',
          label: 'Visitor induction',
          value: n(totals, 'VISITOR_INDUCTION'),
        },
      ],
      observations: [
        { bucket: 'Daily', raised: raised(dTot), closed: closed(dTot) },
        { bucket: 'Weekly', raised: raised(wTot), closed: closed(wTot) },
        { bucket: 'Monthly', raised: raised(mTot), closed: closed(mTot) },
      ],
      glance: {
        totalInspection: n(totals, 'SAFETY_INSPECTION'),
        unsafeActsClosed: n(totals, 'UNSAFE_ACTS_CLOSED'),
        unsafeConditionsClosed: n(totals, 'UNSAFE_CONDITIONS_CLOSED'),
      },
      // Every catalogue metric with its period figure, for the big list.
      statistics: METRIC_CATALOG.map((spec) => ({
        metric: spec.metric,
        label: spec.label,
        kind: spec.kind,
        group: spec.group,
        value:
          spec.kind === 'AUTOMATED'
            ? derived[spec.metric as keyof typeof derived]
            : n(totals, spec.metric),
      })),
      categoryBreakup: {
        total: breakupTotal,
        rows: breakup.map((b) => ({
          ...b,
          percent: breakupTotal > 0 ? Math.round((b.value / breakupTotal) * 100) : 0,
        })),
      },
      reportingSummary: {
        daily: raised(dTot) + closed(dTot),
        weekly: raised(wTot) + closed(wTot),
        monthly: raised(mTot) + closed(mTot),
      },
    };
  }

  /**
   * The trend lines: inductions, toolbox talks and visitor inductions per day.
   *
   * A day with nothing recorded plots as zero rather than being skipped, so the
   * line does not silently join across a gap and imply a level that was never
   * entered.
   */
  private async trendOver(user: AuthUser, sites: string[] | null, start: Date, end: Date) {
    const metrics: SafetyMetric[] = ['LABOUR_INDUCTION', 'TOOLBOX_TALK', 'VISITOR_INDUCTION'];
    const rows = await this.prisma.dailySafetyEntry.findMany({
      where: {
        organizationId: user.organizationId,
        metric: { in: metrics },
        entryDate: { gte: start, lte: end },
        ...(sites ? { siteId: { in: sites } } : {}),
      },
      select: { entryDate: true, metric: true, value: true },
    });

    const days: string[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) days.push(iso(new Date(t)));
    const index = new Map(days.map((d, i) => [d, i]));
    const series = metrics.map((m) => ({
      metric: m,
      label: specFor(m)?.label ?? m,
      values: new Array<number>(days.length).fill(0),
    }));
    for (const r of rows) {
      const i = index.get(iso(r.entryDate));
      const s = series.find((x) => x.metric === r.metric);
      if (i !== undefined && s) s.values[i] += r.value ?? 0;
    }
    return { days, series };
  }

  /**
   * The statistics board as a PDF, for the review meeting.
   *
   * Renders from exactly the `stats` payload the screen draws, so an exported
   * sheet cannot disagree with the page it was exported from.
   */
  async statsPdf(user: AuthUser, opts: { period?: SafetyPeriod; date?: string; siteId?: string }) {
    const s = await this.stats(user, opts);
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { name: true },
    });
    const periodName = s.period[0].toUpperCase() + s.period.slice(1);
    const fmtDay = (v: string) =>
      new Date(`${v}T00:00:00.000Z`).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });

    const buffer = await renderSafetyPdf(
      {
        periodLabel: s.from === s.to ? fmtDay(s.from) : `${fmtDay(s.from)} — ${fmtDay(s.to)}`,
        from: s.from,
        to: s.to,
        siteName: s.siteName,
        kpis: s.kpis,
        trend: {
          days: s.trend.days,
          series: s.trend.series.map((x) => ({ label: x.label, values: x.values })),
        },
        observations: s.observations,
        statistics: s.statistics.map((x) => ({ label: x.label, kind: x.kind, value: x.value })),
        categoryBreakup: { rows: s.categoryBreakup.rows },
      },
      org?.name ?? '',
      periodName,
    );

    return { buffer, filename: `safety-${s.period}-${s.date}.pdf` };
  }

  /** The metric catalogue, so a client never hardcodes twenty-one labels. */
  catalog() {
    return {
      metrics: METRIC_CATALOG,
      safeManHoursPerDay: SAFE_MAN_HOURS_PER_DAY,
      performanceTarget: SAFETY_PERFORMANCE_TARGET,
    };
  }
}
