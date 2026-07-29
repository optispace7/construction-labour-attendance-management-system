'use client';

import * as React from 'react';
import { Box, Grid, Stack, Typography } from '@mui/material';
import { ChartCard } from '@/components/ui/ChartCard';
import { RankedBars, WorkforceTrendChart } from '@/components/dash/charts';
import { formatNumber } from '@/lib/format';

export interface ManpowerReport {
  reportType: string;
  periodLabel: string;
  days: string[];
  trend: number[];
  periodFrom: string;
  totalManDays: number;
  uniqueWorkers: number;
  manHours: number;
  activeTrades: number;
  avgPerDay: number;
  peak: number;
  byTrade: { name: string; count: number }[];
  byVendor: { name: string; count: number }[];
}

/**
 * Contractor hues, mirroring `SERIES` in
 * `backend/src/modules/reports/report.renderer.ts`.
 *
 * Duplicated rather than imported because the panel and the API are separate
 * builds, and kept in this file rather than the shared token palette because it
 * belongs to the report artefact, not to the dashboard. The order was chosen by
 * running the data-viz palette checker over candidate orderings against the dark
 * card surface — change one end without the other and the PDF a client receives
 * stops matching the preview the admin approved.
 */
const SERIES = [
  '#0EA3B0',
  '#E85E4C',
  '#B16DDF',
  '#BD8407',
  '#009AE2',
  '#16AD52',
  '#6D85FA',
  '#DD5B9C',
];

/**
 * Contractor split as one 100% share bar over a ranked legend — the same form
 * the PDF draws, for the same reason: a donut asks the reader to tell a 3%
 * slice from another 3% slice by hue alone, which no palette can do at that
 * size. The tail past seven folds into "Other" rather than reaching for a
 * ninth hue.
 */
function ShareBar({ items }: { items: { name: string; count: number }[] }) {
  const total = items.reduce((a, b) => a + b.count, 0);
  const head = items.slice(0, 7);
  const rest = total - head.reduce((a, b) => a + b.count, 0);
  const parts = rest > 0 ? [...head, { name: 'Other', count: rest }] : head;
  if (total === 0) return null;

  return (
    <Box sx={{ px: 2.25, pb: 2 }}>
      <Box sx={{ display: 'flex', gap: '2px', mb: 2 }}>
        {parts.map((p, i) => (
          <Box
            key={p.name}
            title={`${p.name} — ${Math.round((p.count / total) * 100)}%`}
            sx={{
              flexGrow: p.count,
              flexBasis: 0,
              minWidth: 3,
              height: 14,
              borderRadius: 0.75,
              bgcolor: SERIES[i % SERIES.length],
            }}
          />
        ))}
      </Box>
      <Stack spacing={1}>
        {parts.map((p, i) => (
          <Stack key={p.name} direction="row" alignItems="center" spacing={1.25}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: 0.5,
                flexShrink: 0,
                bgcolor: SERIES[i % SERIES.length],
              }}
            />
            <Typography
              variant="body2"
              color="text.secondary"
              noWrap
              sx={{ flexGrow: 1, minWidth: 0 }}
              title={p.name}
            >
              {p.name}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {Math.round((p.count / total) * 100)}%
            </Typography>
            <Typography
              variant="body2"
              color="text.disabled"
              sx={{ width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              {formatNumber(p.count)}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

/**
 * On-screen twin of the manpower PDF: the daily trend across the full width,
 * then the trade ranking and the contractor split side by side.
 *
 * There are deliberately no headline tiles here either — the admin approving a
 * report should be looking at the same thing the client will open, and six big
 * numbers on screen that are absent from the PDF is exactly how a preview stops
 * being one. Labour only; staff and visitors are excluded upstream.
 */
export function ManpowerReportView({ data }: { data: ManpowerReport }) {
  const noAttendance = data.trend.every((n) => n === 0);

  return (
    <Stack spacing={2}>
      <ChartCard
        title="Daily manpower"
        subtitle={`${data.days.length} day${data.days.length === 1 ? '' : 's'} · labour on site per day`}
        empty={noAttendance}
        emptyText="No labour attendance in this period"
        height={300}
      >
        <WorkforceTrendChart days={data.days} values={data.trend} height={300} />
      </ChartCard>

      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <ChartCard
            title="Workforce by trade"
            subtitle="Man-days in this period"
            empty={data.byTrade.length === 0}
            emptyText="No labour attendance in this period"
            height={260}
          >
            <RankedBars
              rows={data.byTrade.map((t) => ({ key: t.name, label: t.name, value: t.count }))}
              limit={8}
              colorMode="brand"
              emptyLabel="No designation"
            />
          </ChartCard>
        </Grid>
        <Grid item xs={12} md={6}>
          <ChartCard
            title="Workforce by contractor"
            subtitle="Share of man-days"
            empty={data.byVendor.length === 0}
            emptyText="No labour attendance in this period"
            height={260}
          >
            <ShareBar items={data.byVendor} />
          </ChartCard>
        </Grid>
      </Grid>

      <Typography variant="caption" color="text.secondary">
        Labour only — staff and visitors are excluded. Man-days count attendance
        sessions; the PDF renders these same three charts.
      </Typography>
    </Stack>
  );
}
