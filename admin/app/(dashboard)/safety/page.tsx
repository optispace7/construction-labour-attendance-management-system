'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { PageHeader } from '@/components/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { MetricCard } from '@/components/dash/MetricCard';
import { ChartPanel, Item, Panel, PanelHead, Stagger } from '@/components/dash/ui';
import {
  ObservationBars,
  SafetyDonut,
  SafetyScoreDial,
  SafetyTrend,
  type ObservationRow,
  type SliceRow,
  type TrendSeries,
} from '@/components/safety/SafetyCharts';
import { api, apiErrorMessage } from '@/lib/api/browser';
import { formatNumber } from '@/lib/format';
import * as I from '@/components/icons';
import type { Site } from '@/lib/types';
import { HiddenPageGate } from '@/components/HiddenPageGate';
import { MetricDetailDrawer, type DrawerMetric } from '@/components/safety/MetricDetailDrawer';

type Period = 'daily' | 'weekly' | 'monthly' | 'custom';

interface StatRow {
  metric: string;
  label: string;
  kind: 'AUTOMATED' | 'MANUAL';
  group: string;
  value: number;
}

/** One point taken off the month's safety score, with how it was arrived at. */
interface ScoreDeduction {
  label: string;
  points: number;
  detail: string;
}

interface SafetyStats {
  period: Period;
  date: string;
  from: string;
  to: string;
  siteId: string;
  siteName: string | null;
  kpis: {
    /** Man-days inside the selected window. */
    periodManpower: number;
    /** Cumulative man-days through the window's last day. */
    totalManpower: number;
    /** Hours earned inside the window. */
    periodSafeManHours: number;
    safetyPerformance: number;
    safetyPerformanceDeductions: ScoreDeduction[];
    safetyPerformanceTarget: number;
    /** False on windows too short to charge for routine work not done. */
    safetyPerformanceScoredInactivity: boolean;
  };
  trend: { days: string[]; series: TrendSeries[] };
  manpower: {
    days: string[];
    daily: number[];
    cumulative: number[];
    safeManHours: number[];
    dailySafeManHours: number[];
  };
  summary: SliceRow[];
  observations: ObservationRow[];
  glance: { totalInspection: number; unsafeActsClosed: number; unsafeConditionsClosed: number };
  statistics: StatRow[];
  categoryBreakup: { total: number; rows: (SliceRow & { percent: number })[] };
  reportingSummary: { daily: number; weekly: number; monthly: number };
}

const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const shift = (iso: string, days: number) =>
  new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
/** Both ends inclusive, matching the window the API reports. */
const spanDays = (from: string, to: string) =>
  (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
    DAY_MS +
  1;

/** Mirrors MAX_CUSTOM_RANGE_DAYS on the API, so the refusal arrives before the request. */
const MAX_RANGE_DAYS = 366;
/** What a fresh custom range opens on. */
const DEFAULT_RANGE_DAYS = 30;

const PERIODS: { value: Period; label: string }[] = [
  { value: 'daily', label: 'Daily report' },
  { value: 'weekly', label: 'Weekly report' },
  { value: 'monthly', label: 'Monthly report' },
  { value: 'custom', label: 'Custom range' },
];

export default function SafetyStatisticsPage() {
  return (
    <HiddenPageGate>
      <SafetyStatisticsBoard />
    </HiddenPageGate>
  );
}

function SafetyStatisticsBoard() {
  const [siteId, setSiteId] = React.useState('all');
  const [date, setDate] = React.useState(today);
  const [period, setPeriod] = React.useState<Period>('daily');
  const [from, setFrom] = React.useState(() => shift(today(), -(DEFAULT_RANGE_DAYS - 1)));
  const [to, setTo] = React.useState(today);
  const [exporting, setExporting] = React.useState(false);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<DrawerMetric | null>(null);

  const custom = period === 'custom';
  /** The day the board is anchored on, whichever way the window was chosen. */
  const anchor = custom ? to : date;

  // Refused here as well as on the API: a range nobody could mean is not worth
  // a round trip, and the message reads better beside the fields than in a
  // red banner where the chart should be.
  const rangeError = !custom
    ? null
    : // A cleared field, which is what a half-typed date looks like on the way
      // through, is not a backwards range and should not be told it is one.
      !from || !to
      ? 'Pick both a from and a to date.'
      : from > to
        ? 'The from date is after the to date.'
        : spanDays(from, to) > MAX_RANGE_DAYS
          ? `A range covers at most ${MAX_RANGE_DAYS} days.`
          : null;

  /**
   * Keep the two ways of choosing a window in step, so switching between them
   * lands on the same stretch of time rather than jumping back to today.
   */
  function changePeriod(next: Period) {
    if (next === 'custom' && !custom) {
      setTo(date);
      setFrom(shift(date, -(DEFAULT_RANGE_DAYS - 1)));
    } else if (next !== 'custom' && custom) {
      setDate(to);
    }
    setPeriod(next);
  }

  const query = custom
    ? `period=custom&from=${from}&to=${to}&siteId=${siteId}`
    : `period=${period}&date=${date}&siteId=${siteId}`;

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/sites') });

  const stats = useQuery({
    queryKey: ['safety-stats', query],
    queryFn: () => api.get<SafetyStats>(`/safety/stats?${query}`),
    enabled: !rangeError,
    // Editing a range walks through half-typed dates. Holding the last good
    // board means the page keeps its shape instead of blinking through empty
    // states on the way to the one the reader wanted.
    placeholderData: (prev) => prev,
  });

  const d = stats.data;
  const err = stats.isError ? apiErrorMessage(stats.error, 'Could not load the statistics.') : null;
  const loading = stats.isLoading && !d && !rangeError;

  /**
   * Pull the PDF and hand it to the browser as a download.
   *
   * Through /api/safety-report rather than the JSON proxy: that proxy parses
   * every backend reply as JSON, so PDF bytes came back as a 500.
   */
  async function exportReport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`/api/safety-report?${query}`);
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = custom ? `safety-custom-${from}_to_${to}.pdf` : `safety-${period}-${date}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  /**
   * Named off the period the figures on screen were actually built for, not the
   * one in the dropdown. While a new window is loading the last good board is
   * still showing, and labelling those numbers with the pending period is how a
   * card comes to read "Manpower this week" over a day's total.
   */
  const shownPeriod = d?.period ?? period;
  const periodLabel =
    shownPeriod === 'daily'
      ? 'today'
      : shownPeriod === 'weekly'
        ? 'this week'
        : shownPeriod === 'monthly'
          ? 'this month'
          : 'over the range';

  return (
    <Box>
      <PageHeader
        title="Safety statistics"
        subtitle={
          d
            ? `${d.siteName ?? 'All sites'} · ${d.from}${d.from === d.to ? '' : ` to ${d.to}`}`
            : 'Manpower and safe hours come from attendance; the rest from the daily task sheet.'
        }
        action={
          <Button
            variant="contained"
            startIcon={<I.ReportsIcon />}
            // A bad range keeps the last good board on screen, so the export
            // has to be stopped on the range rather than on having data.
            disabled={exporting || !d || Boolean(rangeError)}
            onClick={exportReport}
          >
            {exporting ? 'Exporting…' : 'Export report'}
          </Button>
        }
      />

      <FilterBar>
        <TextField
          select
          size="small"
          label="Project / site"
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="all">All sites</MenuItem>
          {(sites.data ?? []).map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.name}
            </MenuItem>
          ))}
        </TextField>
        {custom ? (
          <>
            <TextField
              type="date"
              size="small"
              label="From"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              InputLabelProps={{ shrink: true }}
              inputProps={{ max: to || today() }}
            />
            <TextField
              type="date"
              size="small"
              label="To"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              InputLabelProps={{ shrink: true }}
              inputProps={{ min: from, max: today() }}
            />
          </>
        ) : (
          <TextField
            type="date"
            size="small"
            label="Date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            inputProps={{ max: today() }}
          />
        )}
        <TextField
          select
          size="small"
          label="Period"
          value={period}
          onChange={(e) => changePeriod(e.target.value as Period)}
          sx={{ minWidth: 170 }}
        >
          {PERIODS.map((p) => (
            <MenuItem key={p.value} value={p.value}>
              {p.label}
            </MenuItem>
          ))}
        </TextField>
      </FilterBar>

      {rangeError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {rangeError}
        </Alert>
      )}

      {exportError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setExportError(null)}>
          {exportError}
        </Alert>
      )}
      {err && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {err}
        </Alert>
      )}

      <Stagger>
        {/* ---- Headline figures ---- */}
        <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Item>
            <MetricCard
              label={`Manpower ${periodLabel}`}
              value={d?.kpis.periodManpower ?? null}
              tooltip="Man-days recorded inside the selected period — labour and staff, not visitors."
              spark={d?.manpower?.daily}
              sparkHeight={92}
              loading={loading}
              tone="brand"
              emphasis
            />
          </Item>
          <Item>
            <MetricCard
              label={`Safe man-hours ${periodLabel}`}
              value={d?.kpis.periodSafeManHours ?? null}
              hint="10h per man-day"
              tooltip="Man-days inside the period, credited at ten hours each."
              spark={d?.manpower?.dailySafeManHours}
              sparkHeight={92}
              loading={loading}
              tone="positive"
            />
          </Item>
          <Item>
            {/* The one figure that is deliberately not a period total: a running
                project count, read as of the last day of the window. */}
            <MetricCard
              label="Total manpower to date"
              value={d?.kpis.totalManpower ?? null}
              hint={d ? `through ${d.to}` : undefined}
              tooltip="Every man-day — labour and staff — from the start of the project up to the last day of the selected period."
              spark={d?.manpower?.cumulative}
              sparkHeight={92}
              loading={loading}
              tone="info"
            />
          </Item>
          <Item>
            <Panel className="flex h-full flex-col">
              <PanelHead
                title="Safety performance"
                subtitle={
                  d && !d.kpis.safetyPerformanceScoredInactivity
                    ? `Score ${periodLabel} · incidents and open findings only`
                    : `Score ${periodLabel}`
                }
              />
              <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-4">
                <SafetyScoreDial
                  value={d?.kpis.safetyPerformance ?? null}
                  target={d?.kpis.safetyPerformanceTarget ?? 90}
                  size={124}
                />
                <ScoreWorking lines={d?.kpis.safetyPerformanceDeductions ?? []} loading={loading} />
              </div>
            </Panel>
          </Item>
        </div>

        {/* ---- Trend, summary, observations ---- */}
        <div className="mb-4 grid gap-4 xl:grid-cols-3">
          <Item className="xl:col-span-1">
            <ChartPanel
              title="Trend overview"
              subtitle="Inductions, toolbox talks and visitor inductions"
              loading={loading}
              error={err}
              onRetry={() => stats.refetch()}
              empty={(d?.trend.series ?? []).every((s) => s.values.every((v) => v === 0))}
              emptyTitle="Nothing recorded in this period"
              emptyDescription="Fill in the daily task sheet and it appears here."
              bodyHeight={260}
              skeleton="block"
            >
              <SafetyTrend days={d?.trend.days ?? []} series={d?.trend.series ?? []} height={240} />
            </ChartPanel>
          </Item>
          <Item>
            <ChartPanel
              title="Summary"
              subtitle="Permits, training, waste and visitors"
              loading={loading}
              error={err}
              onRetry={() => stats.refetch()}
              empty={(d?.summary ?? []).every((s) => s.value === 0)}
              emptyTitle="Nothing recorded in this period"
              bodyHeight={260}
              skeleton="donut"
            >
              <SafetyDonut rows={d?.summary ?? []} centreLabel="total" height={164} />
            </ChartPanel>
          </Item>
          <Item>
            <ChartPanel
              title="Safety observations"
              subtitle="Raised against closed"
              loading={loading}
              error={err}
              onRetry={() => stats.refetch()}
              empty={(d?.observations ?? []).every((o) => o.raised === 0 && o.closed === 0)}
              emptyTitle="Nothing raised in this period"
              bodyHeight={260}
              skeleton="bars"
            >
              <ObservationBars rows={d?.observations ?? []} height={266} />
            </ChartPanel>
          </Item>
        </div>

        {/* ---- Glance, breakup, reporting ---- */}
        <div className="mb-4 grid gap-4 xl:grid-cols-3">
          <Item>
            <Panel className="h-full">
              <PanelHead title="Performance at a glance" subtitle={`Totals ${periodLabel}`} />
              <div className="space-y-1 px-5 pb-4">
                <GlanceRow label="Total inspections" value={d?.glance.totalInspection ?? 0} />
                <GlanceRow label="Unsafe acts closed" value={d?.glance.unsafeActsClosed ?? 0} />
                <GlanceRow
                  label="Unsafe conditions closed"
                  value={d?.glance.unsafeConditionsClosed ?? 0}
                />
              </div>
            </Panel>
          </Item>
          <Item>
            <ChartPanel
              title="Category-wise breakup"
              subtitle="Findings and incidents"
              loading={loading}
              error={err}
              onRetry={() => stats.refetch()}
              empty={(d?.categoryBreakup.total ?? 0) === 0}
              emptyTitle="Nothing recorded in this period"
              bodyHeight={240}
              skeleton="donut"
            >
              <SafetyDonut rows={d?.categoryBreakup.rows ?? []} centreLabel="total" height={164} />
            </ChartPanel>
          </Item>
          <Item>
            <Panel className="h-full">
              <PanelHead title="Reporting summary" subtitle="Findings raised and closed" />
              <div className="grid grid-cols-3 gap-3 px-5 pb-4">
                <ReportTile label="Daily" caption="Today" value={d?.reportingSummary.daily ?? 0} />
                <ReportTile
                  label="Weekly"
                  caption="This week"
                  value={d?.reportingSummary.weekly ?? 0}
                />
                <ReportTile
                  label="Monthly"
                  caption="This month"
                  value={d?.reportingSummary.monthly ?? 0}
                />
              </div>
            </Panel>
          </Item>
        </div>

        {/* ---- The full list ---- */}
        <Item>
          <Panel>
            <PanelHead
              title="Safety statistics"
              subtitle={`Every tracked item, ${periodLabel} · select one for the day-by-day detail`}
            />
            <div className="grid gap-x-4 gap-y-0 px-3 pb-4 sm:grid-cols-2 xl:grid-cols-3">
              {(d?.statistics ?? []).map((s) => (
                <button
                  key={s.metric}
                  type="button"
                  onClick={() =>
                    setDetail({
                      metric: s.metric,
                      label: s.label,
                      group: s.group,
                      periodValue: s.value,
                    })
                  }
                  className="group flex min-w-0 appearance-none items-center gap-2 rounded-lg border-b border-line bg-transparent px-2 py-2 text-left transition-colors last:border-0 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={s.label}>
                    {s.label}
                  </span>
                  <span className="shrink-0 text-[13px] font-bold tabular-nums text-ink">
                    {formatNumber(s.value)}
                  </span>
                  {/* A chevron only on hover: an arrow beside all twenty-one rows
                      would be more ink than the numbers they sit next to. */}
                  <I.ChevronDownIcon className="size-3.5 shrink-0 -rotate-90 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </Panel>
        </Item>
      </Stagger>

      <MetricDetailDrawer
        metric={detail}
        siteId={siteId}
        anchorDate={anchor}
        onClose={() => setDetail(null)}
      />

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        Manpower counts labour and staff — everybody working the site — and leaves visitors out. The
        manpower report is a labour report and still counts labour alone. Every figure covers the
        selected period except total manpower to date, which runs from the start of the project to
        the last day of that period. Safe man-hours are man-days at ten hours each and do not reset
        after an incident.
      </Typography>
    </Box>
  );
}

/**
 * The score's working, under the dial.
 *
 * A weighted score is only as trusted as its arithmetic is visible: without
 * this the card says "84%" and the first question in the review meeting is
 * "why 84?". Scrolls rather than growing, so a bad month cannot stretch the
 * card past the three KPI tiles beside it.
 */
function ScoreWorking({ lines, loading }: { lines: ScoreDeduction[]; loading: boolean }) {
  if (loading) return null;
  if (lines.length === 0) {
    return (
      <p className="px-5 text-center text-[12px] text-ink-faint">
        Nothing deducted — a clean period.
      </p>
    );
  }
  return (
    <div className="max-h-[104px] w-full overflow-y-auto px-5">
      {lines.map((line) => (
        <div
          key={`${line.label}-${line.detail}`}
          className="flex items-baseline gap-2 border-b border-line py-1.5 last:border-0"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] text-ink-muted">{line.label}</span>
            <span className="block truncate text-[10px] text-ink-faint">{line.detail}</span>
          </span>
          <span className="text-[12px] font-bold tabular-nums text-critical">−{line.points}</span>
        </div>
      ))}
    </div>
  );
}

function GlanceRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">{label}</span>
      <span className="text-[15px] font-bold tabular-nums text-ink">{formatNumber(value)}</span>
    </div>
  );
}

function ReportTile({ label, caption, value }: { label: string; caption: string; value: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface-sunken px-3 py-3 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-1 text-[20px] font-bold leading-none tabular-nums text-ink">
        {formatNumber(value)}
      </p>
      <p className="mt-1 text-[11px] text-ink-faint">{caption}</p>
    </div>
  );
}
