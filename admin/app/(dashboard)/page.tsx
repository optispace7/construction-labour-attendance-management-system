'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api, apiErrorMessage } from '@/lib/api/browser';
import { CorrectionRequest, Paginated, Site } from '@/lib/types';
import { changeVs, daySpan, formatHours, formatNumber, pluralise } from '@/lib/format';

import {
  DashboardFilters,
  DashboardHeader,
  DateRange,
  rangeForDays,
} from '@/components/dash/Header';
import { ChartPanel, Item, Panel, SectionLabel, Stagger } from '@/components/dash/ui';
import {
  MetricCard,
  ActivityRow,
  ExceptionRow,
  ShareBar,
  StatTile,
} from '@/components/dash/MetricCard';
import { HoverCard, PeopleList } from '@/components/dash/HoverCard';
import {
  RankedBars,
  RankedRow,
  StatusSplit,
  WorkforceTrendChart,
  useTokens,
} from '@/components/dash/charts';

import { VendorAttendanceChart } from '@/components/dash/VendorAttendance';
import { VendorDonut } from '@/components/dash/VendorDonut';

import { AuditRow, DashboardCharts, DashboardStats, StorageUsageLite } from './types';

/** Audit actions, in the words a site manager would use. */
const ACTIVITY_LABELS: Record<string, string> = {
  AUTH_LOGIN: 'signed in',
  WORKER_CREATE: 'registered a worker',
  WORKER_UPDATE: 'updated a worker',
  WORKER_ASSIGN_SITE: 'assigned a worker to a site',
  CORRECTION_REQUEST: 'raised an attendance correction',
  CORRECTION_APPROVE: 'approved a correction',
  CORRECTION_REJECT: 'declined a correction',
  MANUAL_ATTENDANCE_APPROVE: 'accepted a manual entry',
  MANUAL_ATTENDANCE_REJECT: 'declined a manual entry',
  ATTENDANCE_SESSION_EDIT: 'corrected an attendance record',
  ATTENDANCE_SESSION_DELETE: 'removed an attendance record',
  ATTENDANCE_SESSION_BULK_LOGOUT: 'closed the day for a group',
  ATTENDANCE_SESSION_REOPEN: 'reopened an attendance record',
  SITE_CREATE: 'created a site',
  SITE_UPDATE: 'updated a site',
  DEVICE_UPDATE: 'updated a device',
  USER_CREATE: 'created a user account',
  USER_UPDATE: 'updated a user account',
  USER_DELETE: 'removed a user account',
  AUTH_PASSWORD_RESET: 'reset a password',
};

function activityTone(action: string) {
  if (action.includes('DELETE') || action.includes('REJECT')) return 'critical' as const;
  if (action.includes('APPROVE') || action.includes('CREATE')) return 'positive' as const;
  if (action.startsWith('ATTENDANCE_SESSION')) return 'warning' as const;
  return 'neutral' as const;
}

/**
 * Workforce overview.
 *
 * The order of this page is the argument it makes: what is happening right now
 * (KPIs) → how today compares with the recent past (trend) → where today's
 * people actually are (status, sites) → who supplied them and what they do
 * (vendors, trades) → what needs a human (exceptions, activity). Summary first,
 * detail underneath, nothing said twice in different clothes.
 *
 * Built on Tailwind + Recharts + framer-motion rather than MUI: the page needed
 * real chart control and real motion, and it reads the same design tokens as the
 * rest of the panel so the two systems cannot drift apart.
 */
export default function DashboardV2Page() {
  const router = useRouter();
  const qc = useQueryClient();
  const t = useTokens();

  const [siteId, setSiteId] = React.useState('all');
  const [range, setRange] = React.useState<DateRange>(() => rangeForDays(7));
  const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/sites') });

  const stats = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => api.get<DashboardStats>('/attendance/dashboard-stats'),
    refetchInterval: 30_000,
  });

  const charts = useQuery({
    queryKey: ['dashboard-charts', range.from, range.to],
    queryFn: () =>
      api.get<DashboardCharts>(`/attendance/dashboard-charts?from=${range.from}&to=${range.to}`),
    // Hold the previous window while the next loads, so stepping through weeks
    // does not blank every panel in turn.
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });

  const corrections = useQuery({
    queryKey: ['corrections', 'PENDING'],
    queryFn: () => api.get<CorrectionRequest[]>('/corrections?status=PENDING'),
  });

  const manualPending = useQuery({
    queryKey: ['manual-approvals', 'pending-count'],
    queryFn: () => api.get<{ pending: number }>('/manual-approvals/pending-count'),
    // Some roles do not hold this permission. A refusal is not an error worth
    // showing — the row simply does not appear.
    retry: false,
  });

  const storage = useQuery({
    queryKey: ['storage-usage'],
    queryFn: () => api.get<StorageUsageLite>('/storage/usage'),
    retry: false,
    refetchInterval: 120_000,
  });

  const activity = useQuery({
    queryKey: ['recent-activity'],
    // Scans are audited too, but there are hundreds a day and they would bury
    // every other action in a nine-row summary. The Audit page has them.
    queryFn: () =>
      api.get<Paginated<AuditRow>>(
        '/audit?limit=9&excludeActions=ATTENDANCE_LOGIN,ATTENDANCE_LOGOUT',
      ),
    retry: false,
    refetchInterval: 60_000,
  });

  React.useEffect(() => {
    if (stats.dataUpdatedAt) setLastUpdated(new Date(stats.dataUpdatedAt));
  }, [stats.dataUpdatedAt]);

  const refreshAll = React.useCallback(() => {
    for (const key of [
      'dashboard-stats',
      'dashboard-charts',
      'corrections',
      'manual-approvals',
      'recent-activity',
    ]) {
      qc.invalidateQueries({ queryKey: [key] });
    }
  }, [qc]);

  // ---- Derived figures -----------------------------------------------------
  // Everything below tolerates a missing payload: an older API has no
  // `movement`, and a card with no data must show a dash, never a zero that
  // reads as a fact.

  const movement = stats.data?.movement;
  const today = movement?.today;
  const yesterday = movement?.yesterday;
  const manpower = charts.data?.manpower;

  const onSiteNow = stats.data?.onSiteNow.total ?? null;
  const missed = stats.data?.missedLogout.total ?? null;
  const registered = stats.data?.workforce?.total ?? null;

  /** One category's bucket out of the live stats, people list included. */
  const cat = (key: string) => stats.data?.onSiteNow.byCategory?.[key];

  // The missed-logout buckets are grouped by category; the card shows all of
  // them together, so flatten before handing them to the hover list.
  const missedPeople = React.useMemo(
    () => Object.values(stats.data?.missedLogout.byCategory ?? {}).flatMap((b) => b.people),
    [stats.data],
  );

  const onSiteSplit =
    stats.data?.onSiteNow.today !== undefined && stats.data?.onSiteNow.carriedOver !== undefined
      ? { today: stats.data.onSiteNow.today, carriedOver: stats.data.onSiteNow.carriedOver }
      : null;

  const siteRows: RankedRow[] = React.useMemo(() => {
    const pendingBySite = new Map(
      (charts.data?.correctionsBySite ?? []).map((c) => [c.site, c.pending]),
    );
    return (charts.data?.siteWise ?? []).map((row) => ({
      key: row.site,
      label: row.site,
      value: row.onSite,
      badge: pendingBySite.get(row.site)
        ? {
            value: pendingBySite.get(row.site)!,
            label: 'Corrections awaiting review',
            tone: 'warning' as const,
          }
        : null,
    }));
  }, [charts.data]);

  const tradeRows: RankedRow[] = React.useMemo(
    () => (manpower?.byTrade ?? []).map((x) => ({ key: x.trade, label: x.trade, value: x.count })),
    [manpower],
  );

  const windowDays = daySpan(range.from, range.to);
  const trendDays = manpower?.days ?? [];
  const trendValues = manpower?.trend ?? [];

  const chartsError = charts.isError ? apiErrorMessage(charts.error, 'Could not load charts') : null;
  const statsError = stats.isError
    ? apiErrorMessage(stats.error, 'Could not load live figures')
    : null;

  const statusSegments = React.useMemo(() => {
    const segs = [
      {
        key: 'onSite',
        label: 'Currently on site',
        value: today?.onSite ?? 0,
        color: t.brand,
        description: 'Checked in and not yet out',
      },
      {
        key: 'checkedOut',
        label: 'Checked out',
        value: today?.checkedOut ?? 0,
        color: t.positive,
        description: 'Turned up today and has left',
      },
    ];
    // Only claim an absence when the size of the workforce is known.
    if (registered && registered > 0) {
      segs.push({
        key: 'absent',
        label: 'Not checked in',
        value: Math.max(0, registered - (today?.checkedIn ?? 0)),
        color: t.muted,
        description: 'On the books, no attendance today',
      });
    }
    return segs;
  }, [today, registered, t]);

  const exceptions = [
    {
      label: 'Missing check-outs',
      description: 'Nobody scanned these people out',
      count: missed,
      tone: 'warning' as const,
      onClick: () => router.push('/attendance?view=missed'),
    },
    {
      label: 'Corrections awaiting review',
      description: 'Attendance changes needing approval',
      count: corrections.data?.length ?? null,
      tone: 'warning' as const,
      onClick: () => router.push('/corrections'),
    },
    ...(manualPending.isSuccess
      ? [
          {
            label: 'Manual entries awaiting approval',
            description: 'Typed in by hand — not on the register yet',
            count: manualPending.data.pending,
            tone: 'critical' as const,
            onClick: () => router.push('/attendance/manual-entries'),
          },
        ]
      : []),
    {
      label: 'Late arrivals today',
      description: 'Checked in after their shift started',
      count: today?.lateArrivals ?? null,
      tone: 'info' as const,
      onClick: () => router.push('/attendance'),
    },
    ...(storage.isSuccess && storage.data.level !== 'OK'
      ? [
          {
            label: 'Storage nearly full',
            description: `Database at ${Math.round((storage.data.usedPercent ?? 0) * 100)}% of its limit`,
            count: null,
            tone: 'critical' as const,
            onClick: () => router.push('/storage'),
          },
        ]
      : []),
  ];
  const openExceptions = exceptions.filter((e) => (e.count ?? 0) > 0).length;

  return (
    // data-dash scopes the native-control reset in tailwind.css to this page,
    // so the MUI pages keep their own baseline untouched.
    <div data-dash className="min-w-0 font-sans">
      <DashboardHeader
        sites={sites.data}
        siteId={siteId}
        range={range}
        onRefresh={refreshAll}
        refreshing={stats.isFetching || charts.isFetching}
        lastUpdated={lastUpdated}
        onExport={() => router.push('/reports')}
        headline={{ value: onSiteNow, label: 'on site now' }}
      />

      {/* ---------- 1. Executive summary ---------- */}
      <section className="mb-8">
        <SectionLabel
          title="Right now"
          description="Live figures across your sites, refreshed automatically."
        />
        <Stagger className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {/* The three category counts each carry the list of people behind
              them, so a number that looks wrong can be checked without leaving
              the page — the same affordance the old dashboard had. */}
          <Item>
            <HoverCard content={<PeopleList title="Workers on site" people={cat('WORKER')?.people} total={cat('WORKER')?.count ?? 0} />}>
              <MetricCard
                label="Workers on site"
                value={cat('WORKER')?.count ?? null}
                icon={<HelmetIcon />}
                tone="brand"
                emphasis
                loading={stats.isLoading}
                hint="Logged in right now"
                footer={
                  <ShareBar
                    value={cat('WORKER')?.count ?? null}
                    total={onSiteNow}
                    label="of everyone on site"
                    color={t.brand}
                  />
                }
                onClick={() => router.push('/attendance?category=WORKER')}
              />
            </HoverCard>
          </Item>

          <Item>
            <HoverCard content={<PeopleList title="Staff on site" people={cat('STAFF')?.people} total={cat('STAFF')?.count ?? 0} />}>
              <MetricCard
                label="Staff on site"
                value={cat('STAFF')?.count ?? null}
                icon={<BadgeIcon />}
                tone="warning"
                loading={stats.isLoading}
                hint="Logged in right now"
                footer={
                  <ShareBar
                    value={cat('STAFF')?.count ?? null}
                    total={onSiteNow}
                    label="of everyone on site"
                    color={t.warning}
                  />
                }
                onClick={() => router.push('/attendance?category=STAFF')}
              />
            </HoverCard>
          </Item>

          <Item>
            <HoverCard content={<PeopleList title="Visitors on site" people={cat('VISITOR')?.people} total={cat('VISITOR')?.count ?? 0} />}>
              <MetricCard
                label="Visitors on site"
                value={cat('VISITOR')?.count ?? null}
                icon={<UsersIcon />}
                tone="info"
                loading={stats.isLoading}
                hint="Checked in today"
                footer={
                  <ShareBar
                    value={cat('VISITOR')?.count ?? null}
                    total={onSiteNow}
                    label="of everyone on site"
                    color={t.info}
                  />
                }
                onClick={() => router.push('/attendance?category=VISITOR')}
              />
            </HoverCard>
          </Item>

          <Item>
            <MetricCard
              label="On site today"
              value={onSiteSplit ? onSiteSplit.today : null}
              icon={<ArrowInIcon />}
              tone="positive"
              emphasis
              loading={stats.isLoading}
              hint={onSiteNow !== null ? `${formatNumber(onSiteNow)} open in total` : 'All categories'}
              tooltip="People who scanned in today and have not scanned out. Sessions left open from an earlier day are counted separately."
              change={changeVs(today?.checkedIn, yesterday?.checkedIn)}
              changeLabel="vs yesterday"
              sentiment="neutral"
              // The only card with an honest daily series behind it: the charts
              // endpoint returns one site-wide trend, not one per category.
              spark={trendValues.length > 1 ? trendValues : undefined}
              onClick={() => router.push('/attendance')}
            />
          </Item>
        </Stagger>

        {/* The quiet five. Same numbers, a third of the height — four hero cards
            and five equals on one grid gave the eye nowhere to land, and left a
            lone card stranded at the end of the last row. */}
        <Stagger className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Item>
            <StatTile
              label="Carried over"
              value={onSiteSplit ? onSiteSplit.carriedOver : null}
              icon={<ClockIcon />}
              tone={onSiteSplit?.carriedOver ? 'warning' : 'positive'}
              loading={stats.isLoading}
              tooltip="Sessions still open from a previous day — almost always somebody who went home without scanning out. Close them in Fix attendance so the headcount is right."
              onClick={() => router.push('/attendance?view=missed')}
            />
          </Item>

          <Item>
            <HoverCard
              content={
                <PeopleList
                  title="Missed logouts"
                  people={missedPeople}
                  total={missed ?? 0}
                  emptyText="Nothing to review — everyone was scanned out."
                />
              }
            >
              <StatTile
                label="Missed logouts"
                value={missed}
                icon={<AlertClockIcon />}
                tone={missed ? 'warning' : 'positive'}
                loading={stats.isLoading}
                sentiment="invert"
                onClick={() => router.push('/attendance?view=missed')}
              />
            </HoverCard>
          </Item>

          <Item>
            <StatTile
              label="Corrections"
              value={corrections.data?.length ?? null}
              icon={<RuleIcon />}
              tone={corrections.data?.length ? 'warning' : 'neutral'}
              loading={corrections.isLoading}
              hint="awaiting review"
              onClick={() => router.push('/corrections')}
            />
          </Item>

          <Item>
            <StatTile
              label="Active sites"
              value={sites.data ? sites.data.filter((x) => x.isActive).length : null}
              icon={<BuildingIcon />}
              tone="info"
              loading={sites.isLoading}
              hint="running"
              onClick={() => router.push('/sites')}
            />
          </Item>

          <Item>
            <StatTile
              label="Total sites"
              value={sites.data ? sites.data.length : null}
              icon={<MapIcon />}
              tone="neutral"
              loading={sites.isLoading}
              hint="incl. completed"
              onClick={() => router.push('/sites')}
            />
          </Item>
        </Stagger>
      </section>

      {/* ---------- 2. Primary insight ---------- */}
      <section className="mb-8">
        <SectionLabel
          title="Workforce over time"
          description={`Daily headcount across ${pluralise(windowDays, 'day')}, and where today's people stand.`}
        />
        {/* Everything from here down obeys this bar, so it sits here rather
            than in the page header three sections away. */}
        <DashboardFilters
          sites={sites.data}
          siteId={siteId}
          onSiteChange={setSiteId}
          range={range}
          onRangeChange={setRange}
        />
        <Stagger className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <Item className="xl:col-span-2">
            <ChartPanel
              title="People on site each day"
              subtitle="Each column is that day's headcount"
              loading={charts.isLoading && !charts.data}
              error={chartsError}
              onRetry={() => charts.refetch()}
              empty={trendValues.length === 0 || trendValues.every((n) => n === 0)}
              emptyTitle="No attendance in this period"
              emptyDescription="Pick a different date range, or check that scanning devices are online."
              bodyHeight={300}
            >
              <WorkforceTrendChart days={trendDays} values={trendValues} height={300} />
            </ChartPanel>
          </Item>

          <Item>
            <ChartPanel
              title="Today's attendance"
              skeleton="split"
              subtitle="Where the workforce stands right now"
              loading={stats.isLoading}
              error={statsError}
              onRetry={() => stats.refetch()}
              empty={!today}
              emptyTitle="No movement today"
              emptyDescription="Nobody has checked in yet."
              bodyHeight={300}
            >
              <StatusSplit
                segments={statusSegments}
                total={registered ?? today?.checkedIn ?? 0}
                totalLabel={registered ? 'registered workforce' : 'checked in today'}
              />
            </ChartPanel>
          </Item>
        </Stagger>
      </section>

      {/* ---------- 3. Vendor attendance over time ---------- */}
      <section className="mb-8">
        <SectionLabel
          title="Vendor attendance"
          description="Daily headcount per contractor. Point at a day, or pick a vendor from the legend."
        />
        {/* Two thirds to the time series, one to the share. The daily chart
            carries a bar per contractor per day and a side panel; at half the
            row it had a few pixels per bar to work with. */}
        <Stagger className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <Item className="xl:col-span-2">
            <ChartPanel
              title="Attendance by vendor"
              subtitle={`Each contractor's people on site, day by day over ${pluralise(windowDays, 'day')}`}
              loading={charts.isLoading && !charts.data}
              error={chartsError}
              onRetry={() => charts.refetch()}
              empty={(charts.data?.vendorTrend?.series?.length ?? 0) === 0}
              emptyTitle="No vendor attendance"
              emptyDescription="No labour recorded against a contractor in this period."
              bodyHeight={320}
            >
              {charts.data?.vendorTrend && (
                <VendorAttendanceChart
                  trend={charts.data.vendorTrend}
                  windowDays={windowDays}
                  height={300}
                />
              )}
            </ChartPanel>
          </Item>

          <Item>
            <ChartPanel
              title="Vendor share"
              skeleton="donut"
              subtitle={`Each contractor's share of total attendance over ${pluralise(windowDays, 'day')}`}
              loading={charts.isLoading && !charts.data}
              error={chartsError}
              onRetry={() => charts.refetch()}
              empty={(manpower?.byVendor?.length ?? 0) === 0}
              emptyTitle="No vendor attendance"
              emptyDescription="No labour recorded against a contractor in this period."
              bodyHeight={320}
            >
              <VendorDonut rows={manpower?.byVendor ?? []} />
            </ChartPanel>
          </Item>
        </Stagger>
      </section>

      {/* ---------- 4. Where and who ---------- */}
      <section className="mb-8">
        <SectionLabel
          title="Where the workforce is"
          description="On-site headcount by location, and who supplied the people."
        />
        <Stagger className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
          <Item>
            <ChartPanel
              title="Workforce by site"
              skeleton="rows"
              subtitle="On site right now"
              loading={charts.isLoading && !charts.data}
              error={chartsError}
              onRetry={() => charts.refetch()}
              empty={siteRows.length === 0}
              emptyTitle="Nobody on site"
              emptyDescription="No open attendance sessions anywhere."
              bodyHeight={220}
              footer={
                <p className="text-[12px] text-ink-muted">
                  Amber counts are corrections waiting for review at that site.
                </p>
              }
            >
              <RankedBars rows={siteRows} onRowClick={() => router.push('/attendance')} />
            </ChartPanel>
          </Item>

          <Item>
            <ChartPanel
              title="Workforce by trade"
              skeleton="rows"
              subtitle={`Man-days by designation over ${pluralise(windowDays, 'day')}`}
              loading={charts.isLoading && !charts.data}
              error={chartsError}
              onRetry={() => charts.refetch()}
              empty={tradeRows.length === 0}
              emptyTitle="No trades recorded"
              emptyDescription="Workers in this period have no designation set."
              bodyHeight={220}
            >
              <RankedBars rows={tradeRows} colorMode="categorical" />
            </ChartPanel>
          </Item>
        </Stagger>
      </section>

      {/* ---------- 5. Patterns and follow-ups ---------- */}
      <section className="mb-4">
        <SectionLabel
          title="Patterns and follow-ups"
          description="How the week behaves, what needs attention, and what changed recently."
        />
        <Stagger className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
          <Item>
            <ChartPanel
              title="Needs attention"
              skeleton="rows"
              subtitle={
                openExceptions === 0
                  ? 'Everything is clear'
                  : `${pluralise(openExceptions, 'item')} to look at`
              }
              loading={stats.isLoading}
              bodyHeight={220}
            >
              <div className="pb-2">
                {exceptions.map((e) => (
                  <ExceptionRow key={e.label} {...e} />
                ))}
              </div>
            </ChartPanel>
          </Item>

          <Item>
            <ChartPanel
              title="Recent activity"
              skeleton="rows"
              subtitle="Changes people made, newest first"
              loading={activity.isLoading}
              error={
                activity.isError ? apiErrorMessage(activity.error, 'Could not load activity') : null
              }
              onRetry={() => activity.refetch()}
              empty={(activity.data?.data?.length ?? 0) === 0}
              emptyTitle="Nothing recent"
              emptyDescription="Attendance scans are not listed here — see the Audit page."
              bodyHeight={220}
              footer={
                <button
                  type="button"
                  onClick={() => router.push('/audit')}
                  className="text-[12px] font-semibold text-brand hover:underline"
                >
                  View the full audit trail →
                </button>
              }
            >
              <div className="py-1.5">
                {(activity.data?.data ?? []).map((row, i, arr) => (
                  <ActivityRow
                    key={row.id}
                    actor={row.actorName ?? 'System'}
                    description={
                      ACTIVITY_LABELS[row.action] ?? row.action.replace(/_/g, ' ').toLowerCase()
                    }
                    detail={row.entityName}
                    at={row.createdAt}
                    tone={activityTone(row.action)}
                    last={i === arr.length - 1}
                  />
                ))}
              </div>
            </ChartPanel>
          </Item>
        </Stagger>
      </section>

      {siteId !== 'all' && (
        <p className="text-[12px] text-ink-faint">
          The site filter applies to the period charts. The live figures at the top are org-wide.
        </p>
      )}
    </div>
  );
}

/* ---- Icons. Inline so the dashboard carries no icon-font dependency. ---- */
const ico = 'size-full';
const HelmetIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="M3 16a9 9 0 0 1 18 0" strokeLinecap="round" />
    <path d="M2 16h20v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2Z" strokeLinejoin="round" />
    <path d="M10 7.2V4.6a.6.6 0 0 1 .6-.6h2.8a.6.6 0 0 1 .6.6v2.6" strokeLinejoin="round" />
  </svg>
);
const UsersIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3.2 3.2 0 0 1 0 5M18 19a5.5 5.5 0 0 0-2.2-4.4" strokeLinecap="round" />
  </svg>
);
const ArrowInIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" strokeLinecap="round" />
    <path d="M10 8l4 4-4 4M14 12H4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ArrowOutIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" strokeLinecap="round" />
    <path d="M16 8l4 4-4 4M20 12H10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ClockIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const TimerIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <circle cx="12" cy="13" r="7.5" />
    <path d="M12 9.5V13M9.5 2.5h5M18.5 6.5l1.5-1.5" strokeLinecap="round" />
  </svg>
);
const BuildingIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="M3 20h18M5 20V6l7-3v17M19 20V11l-7-3" strokeLinejoin="round" />
    <path d="M8.5 8.5v.01M8.5 12v.01M8.5 15.5v.01M15.5 13v.01M15.5 16.5v.01" strokeLinecap="round" />
  </svg>
);
const BadgeIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <rect x="4" y="6" width="16" height="14" rx="2.5" strokeLinejoin="round" />
    <path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="2" />
    <path d="M8.5 17c.7-1.5 2-2.3 3.5-2.3s2.8.8 3.5 2.3" strokeLinecap="round" />
  </svg>
);
const AlertClockIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="M20.4 13.6A8.5 8.5 0 1 1 12 3.5" strokeLinecap="round" />
    <path d="M12 7.5V12l2.6 1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M19.5 3v4.2M19.5 9.6v.01" strokeLinecap="round" />
  </svg>
);
const RuleIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="M3 6h9M3 12h6M3 18h9" strokeLinecap="round" />
    <path d="m15 8 2.5 2.5L22 6M15 18l2.5 2.5L22 16" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const MapIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="m3 6.5 6-2.5 6 2.5 6-2.5v13l-6 2.5-6-2.5-6 2.5v-13Z" strokeLinejoin="round" />
    <path d="M9 4v13M15 7v13" strokeLinecap="round" />
  </svg>
);
const ToolIcon = () => (
  <svg viewBox="0 0 24 24" className={ico} fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path
      d="M14.5 6.5a3.5 3.5 0 0 0 4.6 4.6l-7.6 7.6a2.1 2.1 0 0 1-3-3l7.6-7.6a3.5 3.5 0 0 0-1.6-1.6Z"
      strokeLinejoin="round"
    />
    <path d="M6 6l3 3" strokeLinecap="round" />
  </svg>
);
