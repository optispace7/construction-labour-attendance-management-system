'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatDay, formatNumber, formatWeekday } from '@/lib/format';
import { useSeriesPalette, useTokens } from '@/components/dash/charts';

/**
 * The safety board's charts.
 *
 * Colours come from the panel's own categorical palette rather than the one the
 * client-facing PDF uses: this page sits beside every other admin chart and has
 * to match them, and it inherits light mode from the theme toggle, which the
 * PDF's dark-only palette was never stepped for.
 */

/** The shared tooltip surface, matching the workforce dashboard's. */
function TipShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 shadow-elevated">
      {children}
    </div>
  );
}

interface TipRow {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string | number;
}

function SeriesTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TipRow[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <TipShell>
      {label && <p className="mb-1 text-[12px] font-semibold text-ink">{label}</p>}
      {payload.map((p) => (
        <div key={String(p.dataKey ?? p.name)} className="flex items-center gap-2 text-[12px]">
          <span className="size-2 shrink-0 rounded-sm" style={{ background: p.color }} />
          <span className="text-ink-muted">{p.name}</span>
          <span className="ml-auto font-semibold tabular-nums text-ink">
            {formatNumber(Math.round(p.value ?? 0))}
          </span>
        </div>
      ))}
    </TipShell>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 pb-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 shrink-0 rounded-sm" style={{ background: i.color }} />
          <span className="text-[12px] text-ink-muted">{i.label}</span>
        </span>
      ))}
    </div>
  );
}

export interface TrendSeries {
  metric: string;
  label: string;
  values: number[];
}

/**
 * Inductions, toolbox talks and visitor inductions over the period.
 *
 * Lines rather than bars: these are three series on one axis and the question is
 * how each moves, which a grouped bar chart of three colours per day answers far
 * less directly.
 */
export function SafetyTrend({
  days,
  series,
  height = 240,
}: {
  days: string[];
  series: TrendSeries[];
  height?: number;
}) {
  const t = useTokens();
  const palette = useSeriesPalette();
  const useWeekday = days.length <= 14;

  const data = React.useMemo(
    () =>
      days.map((d, i) => {
        const row: Record<string, string | number> = {
          label: useWeekday ? formatWeekday(d) : formatDay(d),
        };
        for (const s of series) row[s.metric] = s.values[i] ?? 0;
        return row;
      }),
    [days, series, useWeekday],
  );

  return (
    <div className="min-w-0">
      <Legend
        items={series.map((s, i) => ({ label: s.label, color: palette[i % palette.length] }))}
      />
      <div style={{ height }} className="w-full px-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 14, left: -14, bottom: 4 }}>
            <CartesianGrid stroke={t.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: t.label, fontSize: 11 }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={40}
              allowDecimals={false}
              tick={{ fill: t.label, fontSize: 11 }}
            />
            <Tooltip content={<SeriesTip />} animationDuration={140} />
            {series.map((s, i) => (
              <Line
                key={s.metric}
                type="monotone"
                dataKey={s.metric}
                name={s.label}
                stroke={palette[i % palette.length]}
                strokeWidth={2}
                dot={{ r: 2.5, strokeWidth: 0 }}
                activeDot={{ r: 4.5 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export interface SliceRow {
  key: string;
  label: string;
  value: number;
}

/**
 * A donut with its total in the middle, plus the rows beside it.
 *
 * The legend rows carry the numbers, so the ring is only ever asked to show
 * rough proportion — never to be measured slice against slice.
 */
export function SafetyDonut({
  rows,
  centreLabel,
  height = 240,
}: {
  rows: SliceRow[];
  centreLabel?: string;
  height?: number;
}) {
  const t = useTokens();
  const palette = useSeriesPalette();
  const total = rows.reduce((a, b) => a + b.value, 0);
  const data = rows.filter((r) => r.value > 0);

  return (
    <div className="flex min-w-0 flex-col gap-2 px-5 pb-4 sm:flex-row sm:items-center">
      <div style={{ height, width: height }} className="relative mx-auto shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data.length ? data : [{ key: 'none', label: 'None', value: 1 }]}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={data.length > 1 ? 2 : 0}
              strokeWidth={0}
            >
              {(data.length ? data : [{ key: 'none' }]).map((r, i) => (
                <Cell
                  key={r.key}
                  fill={data.length ? palette[i % palette.length] : t.sunken}
                />
              ))}
            </Pie>
            {data.length > 0 && <Tooltip content={<SeriesTip />} animationDuration={140} />}
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p className="text-[22px] font-bold leading-none text-ink">{formatNumber(total)}</p>
            {centreLabel && <p className="mt-1 text-[11px] text-ink-faint">{centreLabel}</p>}
          </div>
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-1.5">
        {rows.map((r, i) => (
          <li key={r.key} className="flex min-w-0 items-center gap-2 text-[13px]">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: palette[i % palette.length] }}
            />
            <span className="min-w-0 flex-1 truncate text-ink-muted" title={r.label}>
              {r.label}
            </span>
            <span className="shrink-0 font-semibold tabular-nums text-ink">
              {formatNumber(r.value)}
            </span>
            <span className="w-9 shrink-0 text-right tabular-nums text-ink-faint">
              {total > 0 ? Math.round((r.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface ObservationRow {
  bucket: string;
  raised: number;
  closed: number;
}

/**
 * Raised against closed, for the day, the week and the month side by side.
 *
 * Two status hues rather than two categorical ones: "raised" and "closed" are
 * states of the same finding, not two different things being counted.
 */
export function ObservationBars({
  rows,
  height = 240,
}: {
  rows: ObservationRow[];
  height?: number;
}) {
  const t = useTokens();
  return (
    <div className="min-w-0">
      <Legend
        items={[
          { label: 'Raised', color: t.warning },
          { label: 'Closed', color: t.positive },
        ]}
      />
      <div style={{ height }} className="w-full px-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 14, left: -14, bottom: 4 }}>
            <CartesianGrid stroke={t.grid} vertical={false} />
            <XAxis
              dataKey="bucket"
              tickLine={false}
              axisLine={false}
              tick={{ fill: t.label, fontSize: 11 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={40}
              allowDecimals={false}
              tick={{ fill: t.label, fontSize: 11 }}
            />
            <Tooltip content={<SeriesTip />} cursor={{ fill: t.grid }} animationDuration={140} />
            <Bar dataKey="raised" name="Raised" fill={t.warning} radius={[5, 5, 0, 0]} maxBarSize={34} />
            <Bar dataKey="closed" name="Closed" fill={t.positive} radius={[5, 5, 0, 0]} maxBarSize={34} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
