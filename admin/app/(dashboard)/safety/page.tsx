'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { PageHeader } from '@/components/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { MetricCard } from '@/components/dash/MetricCard';
import { AttendanceRing } from '@/components/dash/charts';
import { ChartPanel, Item, Panel, PanelHead, Stagger } from '@/components/dash/ui';
import {
  ObservationBars,
  SafetyDonut,
  SafetyTrend,
  type ObservationRow,
  type SliceRow,
  type TrendSeries,
} from '@/components/safety/SafetyCharts';
import { api, apiErrorMessage } from '@/lib/api/browser';
import { formatNumber } from '@/lib/format';
import * as I from '@/components/icons';
import type { Site } from '@/lib/types';

type Period = 'daily' | 'weekly' | 'monthly';

interface StatRow {
  metric: string;
  label: string;
  kind: 'AUTOMATED' | 'MANUAL';
  group: string;
  value: number;
}

interface SafetyStats {
  period: Period;
  date: string;
  from: string;
  to: string;
  siteId: string;
  siteName: string | null;
  kpis: {
    dailyManpower: number;
    totalManpower: number;
    totalSafeManHours: number;
    safetyPerformance: number | null;
    safetyPerformanceTarget: number;
  };
  trend: { days: string[]; series: TrendSeries[] };
  summary: SliceRow[];
  observations: ObservationRow[];
  glance: { totalInspection: number; unsafeActsClosed: number; unsafeConditionsClosed: number };
  statistics: StatRow[];
  categoryBreakup: { total: number; rows: (SliceRow & { percent: number })[] };
  reportingSummary: { daily: number; weekly: number; monthly: number };
}

const today = () => new Date().toISOString().slice(0, 10);

const PERIODS: { value: Period; label: string }[] = [
  { value: 'daily', label: 'Daily report' },
  { value: 'weekly', label: 'Weekly report' },
  { value: 'monthly', label: 'Monthly report' },
];

export default function SafetyStatisticsPage() {
  const [siteId, setSiteId] = React.useState('all');
  const [date, setDate] = React.useState(today);
  const [period, setPeriod] = React.useState<Period>('daily');
  const [exporting, setExporting] = React.useState(false);
  const [exportError, setExportError] = React.useState<string | null>(null);

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/sites') });

  const stats = useQuery({
    queryKey: ['safety-stats', period, date, siteId],
    queryFn: () =>
      api.get<SafetyStats>(`/safety/stats?period=${period}&date=${date}&siteId=${siteId}`),
  });

  const d = stats.data;
  const err = stats.isError ? apiErrorMessage(stats.error, 'Could not load the statistics.') : null;
  const loading = stats.isLoading && !d;

  /** Pull the PDF through the proxy and hand it to the browser as a download. */
  async function exportReport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(
        `/api/proxy/safety/stats/pdf?period=${period}&date=${date}&siteId=${siteId}`,
      );
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `safety-${period}-${date}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  const periodLabel =
    period === 'daily' ? 'today' : period === 'weekly' ? 'this week' : 'this month';

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
            disabled={exporting || !d}
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
        <TextField
          type="date"
          size="small"
          label="Date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          InputLabelProps={{ shrink: true }}
          inputProps={{ max: today() }}
        />
        <TextField
          select
          size="small"
          label="Period"
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          sx={{ minWidth: 170 }}
        >
          {PERIODS.map((p) => (
            <MenuItem key={p.value} value={p.value}>
              {p.label}
            </MenuItem>
          ))}
        </TextField>
      </FilterBar>

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
              label="Today's manpower"
              value={d?.kpis.dailyManpower ?? null}
              hint="Automated"
              tooltip="Labour man-days recorded on the selected date."
              loading={loading}
              tone="brand"
              emphasis
            />
          </Item>
          <Item>
            <MetricCard
              label="Total manpower as of now"
              value={d?.kpis.totalManpower ?? null}
              hint="Automated"
              tooltip="Every labour man-day up to and including the selected date."
              loading={loading}
              tone="info"
            />
          </Item>
          <Item>
            <MetricCard
              label="Total safe man-hours"
              value={d?.kpis.totalSafeManHours ?? null}
              hint="Automated · 10h per man-day"
              tooltip="Cumulative man-days credited at ten hours each."
              loading={loading}
              tone="positive"
            />
          </Item>
          <Item>
            <Panel className="flex h-full flex-col">
              <PanelHead
                title="Safety performance"
                subtitle={`Closure rate ${periodLabel === 'today' ? 'this month' : periodLabel}`}
              />
              <div className="grid flex-1 place-items-center pb-4">
                <AttendanceRing
                  value={d?.kpis.safetyPerformance ?? null}
                  label="closed"
                  caption={`Target ≥ ${d?.kpis.safetyPerformanceTarget ?? 90}%`}
                  size={150}
                />
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
              <SafetyDonut rows={d?.summary ?? []} centreLabel="total" height={210} />
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
              <ObservationBars rows={d?.observations ?? []} height={240} />
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
              <SafetyDonut rows={d?.categoryBreakup.rows ?? []} centreLabel="total" height={200} />
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
              subtitle={`Every tracked item, ${periodLabel}`}
            />
            <div className="grid gap-x-6 gap-y-0 px-5 pb-4 sm:grid-cols-2 xl:grid-cols-3">
              {(d?.statistics ?? []).map((s) => (
                <div
                  key={s.metric}
                  className="flex min-w-0 items-center gap-2 border-b border-line py-2 last:border-0"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={s.label}>
                    {s.label}
                  </span>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={s.kind === 'AUTOMATED' ? 'Automated' : 'Manual'}
                    color={s.kind === 'AUTOMATED' ? 'success' : 'default'}
                    sx={{ height: 20, fontSize: '0.68rem' }}
                  />
                  <span className="w-16 shrink-0 text-right text-[13px] font-bold tabular-nums text-ink">
                    {formatNumber(s.value)}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        </Item>
      </Stagger>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        Manpower counts labour only, matching the manpower report. Safe man-hours are cumulative
        man-days at ten hours each and do not reset after an incident.
      </Typography>
    </Box>
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

function ReportTile({
  label,
  caption,
  value,
}: {
  label: string;
  caption: string;
  value: number;
}) {
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
