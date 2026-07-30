'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  PolarAngleAxis,
} from 'recharts';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/cn';
import { formatDay, formatNumber, formatWeekday } from '@/lib/format';
import { categoricalPalette, type ColorMode } from '@/theme/tokens';
import { useElementWidth } from '@/lib/useElementWidth';
import { EASE } from './ui';

/**
 * Every chart on the workforce dashboard, on Recharts.
 *
 * Colours come from the `--clams-*` custom properties rather than props, so a
 * chart repaints with the theme toggle without React re-rendering it, and there
 * is exactly one place a status colour is defined. Recharts needs concrete
 * values for some SVG attributes, so `useTokens` reads the computed values once
 * per theme change.
 */

/** Reads the live token values. Re-runs when the theme attribute flips. */
export function useTokens() {
  const read = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return {
        mode: 'dark' as ColorMode,
        brand: '#6E8FE8',
        positive: '#3FBF87',
        warning: '#E0A438',
        critical: '#EE6A6A',
        info: '#57B6D9',
        grid: 'rgba(255,255,255,0.06)',
        label: '#8C99AC',
        surface: '#151B26',
        sunken: '#10161F',
        border: '#232C3A',
        ink: '#E8ECF2',
        muted: '#98A5B8',
      };
    }
    const s = getComputedStyle(document.documentElement);
    const v = (n: string, fallback: string) => s.getPropertyValue(n).trim() || fallback;
    return {
      // The attribute, not a media query: the toggle can put the panel in light
      // mode on a machine whose OS is set to dark.
      mode: (document.documentElement.getAttribute('data-theme') === 'light'
        ? 'light'
        : 'dark') as ColorMode,
      brand: v('--clams-brand', '#6E8FE8'),
      positive: v('--clams-positive', '#3FBF87'),
      warning: v('--clams-warning', '#E0A438'),
      critical: v('--clams-critical', '#EE6A6A'),
      info: v('--clams-info', '#57B6D9'),
      grid: v('--clams-chart-grid', 'rgba(255,255,255,0.06)'),
      label: v('--clams-chart-label', '#8C99AC'),
      surface: v('--clams-surface', '#151B26'),
      sunken: v('--clams-surface-sunken', '#10161F'),
      border: v('--clams-border', '#232C3A'),
      ink: v('--clams-text-primary', '#E8ECF2'),
      muted: v('--clams-text-secondary', '#98A5B8'),
    };
  }, []);

  const [tokens, setTokens] = React.useState(read);

  React.useEffect(() => {
    setTokens(read());
    // The mode switch changes an attribute on <html>, not React state, so the
    // charts have to be told about it directly.
    const observer = new MutationObserver(() => setTokens(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, [read]);

  return tokens;
}

/**
 * True only for the chart's first second on screen.
 *
 * Recharts replays its entrance whenever the container is re-measured, so a
 * window resize — or a sidebar collapsing — makes every chart wipe itself and
 * redraw. That reads as a glitch, not as polish. Switching animation off once
 * the entrance has played keeps the introduction and drops the flicker.
 */
function useAnimateOnce(enabled = true) {
  const [animate, setAnimate] = React.useState(enabled);
  React.useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => setAnimate(false), 1100);
    return () => clearTimeout(t);
  }, [enabled]);
  return animate;
}

/**
 * Identity hues for vendors and trades — never for a status.
 *
 * Comes from the shared categorical palette rather than a list assembled out of
 * the status colours. Those were picked to be told apart from *each other* one
 * at a time, not to sit in a row of eight: in light mode `brand` (#3E5BA9) and
 * `info` (#2B6CB0) are both mid-blue, so two contractors' bars were effectively
 * the same colour. The token palette alternates warm and cool by design.
 */
export function useSeriesPalette() {
  const { mode } = useTokens();
  return React.useMemo(() => categoricalPalette(mode), [mode]);
}

/** The shared tooltip surface, so every chart's hover looks the same. */
function TooltipShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 shadow-elevated">
      {children}
    </div>
  );
}

interface TipPayload {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string | number;
}

function WorkforceTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TipPayload[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <TooltipShell>
      <p className="mb-1 text-[12px] font-semibold text-ink">{label}</p>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2 text-[12px]">
          <span className="size-2 shrink-0 rounded-sm" style={{ background: p.color }} />
          <span className="text-ink-muted">{p.name}</span>
          <span className="ml-auto font-semibold tabular-nums text-ink">
            {formatNumber(Math.round(p.value ?? 0))}
          </span>
        </div>
      ))}
    </TooltipShell>
  );
}

/**
 * The headline chart: daily headcount as gradient columns.
 *
 * Columns rather than an area, because a daily headcount is a discrete count —
 * an area implies a quantity flowing between days and invites reading a value
 * off a Tuesday nobody measured.
 *
 * The bars are the whole chart. A rolling-mean trend line used to run through
 * them, but a smoothed average is a second, differently-defined number sharing
 * one axis with the counts, and people read it as though days on the line were
 * measured. Peak and average in the header say the same thing without inviting
 * that mistake.
 */
export function WorkforceTrendChart({
  days,
  values,
  height = 300,
}: {
  days: string[];
  values: number[];
  height?: number;
}) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const animate = useAnimateOnce(!reduced);

  const data = React.useMemo(() => {
    const safe = values.map((v) => (Number.isFinite(v) ? v : 0));
    const useWeekday = days.length <= 14;
    return days.map((d, i) => ({
      label: useWeekday ? formatWeekday(d) : formatDay(d),
      people: safe[i] ?? 0,
    }));
  }, [days, values]);

  const peak = Math.max(0, ...data.map((d) => d.people));
  const avg = data.length ? data.reduce((a, d) => a + d.people, 0) / data.length : 0;
  const gid = React.useId().replace(/:/g, '');

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 pb-2">
        <LegendSwatch color={t.brand} label="People on site" />
        <p className="ml-auto text-[12px] text-ink-muted">
          Peak <b className="text-ink">{formatNumber(peak)}</b> · Average{' '}
          <b className="text-ink">{formatNumber(Math.round(avg))}</b>
        </p>
      </div>

      <div style={{ height }} className="w-full px-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 14, left: -14, bottom: 4 }}>
            <defs>
              <linearGradient id={`bar-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={t.brand} stopOpacity={0.95} />
                <stop offset="100%" stopColor={t.brand} stopOpacity={0.35} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke={t.grid} strokeDasharray="3 4" vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tick={{ fill: t.label, fontSize: 11 }}
              // Recharts drops labels that will not fit rather than overlapping
              // them, which is what we want on a phone.
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={44}
              allowDecimals={false}
              tick={{ fill: t.label, fontSize: 11 }}
            />
            <Tooltip
              content={<WorkforceTip />}
              cursor={{ fill: t.grid }}
              animationDuration={140}
            />

            <Bar
              dataKey="people"
              name="People on site"
              fill={`url(#bar-${gid})`}
              radius={[5, 5, 0, 0]}
              maxBarSize={46}
              isAnimationActive={animate}
              animationDuration={620}
              animationEasing="ease-out"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} />
      <span className="text-[12px] text-ink-muted">{label}</span>
    </span>
  );
}

/**
 * Attendance rate as a single arc.
 *
 * One share against its remainder is the one case where a radial reads better
 * than a bar — there is nothing to compare it with, so the shape is decoration
 * around a number rather than the thing being measured.
 */
export function AttendanceRing({
  value,
  label,
  caption,
  size = 168,
}: {
  /** 0–100, or null when there is no denominator to divide by. */
  value: number | null;
  label: string;
  caption?: string;
  size?: number;
}) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const animate = useAnimateOnce(!reduced);
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  const tone = pct >= 85 ? t.positive : pct >= 60 ? t.warning : t.critical;

  return (
    <div className="flex flex-col items-center py-1">
      <div style={{ width: size, height: size }} className="relative">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            innerRadius="72%"
            outerRadius="100%"
            data={[{ name: label, value: pct, fill: value === null ? t.border : tone }]}
            startAngle={90}
            endAngle={-270}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
            <RadialBar
              background={{ fill: t.sunken }}
              dataKey="value"
              cornerRadius={999}
              isAnimationActive={animate}
              animationDuration={950}
              animationEasing="ease-out"
            />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[28px] font-bold leading-none tabular-nums tracking-tight text-ink">
            {value === null ? '–' : `${Math.round(value)}%`}
          </span>
          <span className="mt-1 text-[12px] text-ink-muted">{label}</span>
        </div>
      </div>
      {caption && (
        <p className="mt-2 max-w-[220px] text-center text-[12px] text-ink-muted">{caption}</p>
      )}
    </div>
  );
}

export interface RankedRow {
  key: string;
  label: string;
  value: number;
  meta?: string | null;
  badge?: { value: number; label: string; tone: 'warning' | 'critical' | 'info' } | null;
}

/**
 * One ranked horizontal comparison, reused for sites, vendors and trades.
 *
 * Horizontal because the labels are long ("Reinforcement Steel Fixer"), there
 * are usually more than five, and the question is always "who is biggest" — a
 * ranking. A pie with nine slices answers none of that and cannot fit the words.
 * The bar sits under its label rather than behind it, so a long name never
 * collides with the fill.
 */
export function RankedBars({
  rows,
  limit = 6,
  colorMode = 'brand',
  onRowClick,
  emptyLabel = 'Unassigned',
}: {
  rows: RankedRow[];
  limit?: number;
  colorMode?: 'brand' | 'categorical';
  onRowClick?: (row: RankedRow) => void;
  emptyLabel?: string;
}) {
  const t = useTokens();
  const palette = useSeriesPalette();
  const reduced = useReducedMotion();
  const [expanded, setExpanded] = React.useState(false);

  const sorted = React.useMemo(
    () => [...rows].filter((r) => Number.isFinite(r.value)).sort((a, b) => b.value - a.value),
    [rows],
  );
  const max = sorted.length ? Math.max(...sorted.map((r) => r.value)) : 0;
  const visible = expanded ? sorted : sorted.slice(0, limit);
  const hidden = sorted.length - visible.length;

  // Written out in full: Tailwind scans source for literal class strings, so a
  // template like `bg-${tone}-subtle` produces no CSS at all.
  const badgeClass = {
    warning: 'bg-warning-subtle text-warning',
    critical: 'bg-critical-subtle text-critical',
    info: 'bg-info-subtle text-info',
  } as const;

  return (
    <div className="px-3 pb-3">
      <ul className="space-y-0.5">
        {visible.map((row, i) => {
          const width = max > 0 ? (row.value / max) * 100 : 0;
          const color = colorMode === 'categorical' ? palette[i % palette.length] : t.brand;
          const clickable = !!onRowClick;

          return (
            <li key={row.key}>
              <div
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => onRowClick?.(row) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onRowClick?.(row);
                        }
                      }
                    : undefined
                }
                className={cn(
                  'rounded-lg px-2.5 py-2 transition-colors',
                  clickable && 'cursor-pointer hover:bg-surface-hover focus-visible:outline-2',
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={row.label}>
                    {row.label || emptyLabel}
                  </span>
                  {row.badge && row.badge.value > 0 && (
                    <span
                      title={row.badge.label}
                      className={cn(
                        'shrink-0 rounded px-1.5 py-px text-[12px] font-bold tabular-nums',
                        badgeClass[row.badge.tone],
                      )}
                    >
                      {row.badge.value}
                    </span>
                  )}
                  <span className="shrink-0 text-[13px] font-bold tabular-nums text-ink">
                    {formatNumber(row.value)}
                  </span>
                </div>

                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: color }}
                    initial={reduced ? false : { width: 0 }}
                    animate={{ width: `${width}%` }}
                    transition={{ duration: 0.7, ease: EASE, delay: i * 0.045 }}
                  />
                </div>
                {row.meta && <p className="mt-1 truncate text-[12px] text-ink-faint">{row.meta}</p>}
              </div>
            </li>
          );
        })}
      </ul>

      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-1.5 appearance-none rounded-md bg-transparent px-2.5 py-1 text-[12px] font-semibold text-brand transition-colors hover:bg-surface-hover"
        >
          {expanded ? 'Show less' : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

/**
 * Today's workforce as one bar split by state.
 *
 * A stacked bar, not a donut: these are parts of one known whole and the reader
 * is comparing them, which is a length judgement. People read lengths on a
 * shared baseline accurately and angles poorly — which is exactly why a donut
 * with a 4% and a 6% slice tells you nothing.
 */
export function StatusSplit({
  segments,
  total,
  totalLabel,
}: {
  segments: { key: string; label: string; value: number; color: string; description: string }[];
  total: number;
  totalLabel: string;
}) {
  const reduced = useReducedMotion();
  const shown = segments.filter((s) => s.value > 0);
  const sum = shown.reduce((a, s) => a + s.value, 0);
  // Guard the divisor: an empty day renders an empty track, never NaN widths.
  const denom = Math.max(sum, total, 1);

  return (
    <div className="px-5 pb-4">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-[30px] font-bold leading-none tabular-nums tracking-tight text-ink">
          {formatNumber(total)}
        </span>
        <span className="text-[13px] text-ink-muted">{totalLabel}</span>
      </div>

      <div className="flex h-9 gap-[3px] overflow-hidden rounded-lg border border-line bg-surface-sunken p-[3px]">
        {shown.map((s, i) => (
          <motion.div
            key={s.key}
            title={`${s.label}: ${formatNumber(s.value)}`}
            className="rounded-[5px] transition-[filter] hover:brightness-110"
            style={{ background: s.color }}
            initial={reduced ? false : { width: 0 }}
            animate={{ width: `${(s.value / denom) * 100}%` }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.08 + i * 0.07 }}
          />
        ))}
      </div>

      <ul className="mt-3 space-y-0.5">
        {segments.map((s) => (
          <li
            key={s.key}
            className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-surface-hover"
          >
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: s.value > 0 ? s.color : 'var(--clams-border)' }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink">{s.label}</p>
              <p className="truncate text-[12px] text-ink-muted">{s.description}</p>
            </div>
            <span className="shrink-0 text-[13px] font-bold tabular-nums text-ink">
              {formatNumber(s.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Axis-free trend line drawn under a KPI value.
 *
 * Drawn at the element's real pixel size rather than in a 100-wide viewBox
 * stretched to fit. `preserveAspectRatio="none"` across a 370px card meant
 * roughly 3.7× horizontal scale against 1× vertical, and everything about a
 * stroke suffers under that: round caps and joins come out as flattened
 * ellipses, and the draw-on animation — which framer-motion implements with
 * `stroke-dasharray` — measures its dashes in user units that no longer
 * correspond to what is on screen, so the line can settle part-drawn. Under
 * `prefers-reduced-motion` the animation is skipped and it looks fine, which is
 * exactly why it survived the first review.
 *
 * Measuring costs one ResizeObserver and removes the whole class of problem:
 * one user unit is one pixel, so the geometry is honest and no scaling
 * correction is needed anywhere.
 */
export function Sparkline({
  data,
  color,
  height = 38,
}: {
  data: number[];
  color: string;
  height?: number;
}) {
  const id = React.useId().replace(/:/g, '');
  const reduced = useReducedMotion();
  const [ref, width] = useElementWidth<HTMLDivElement>();

  const points = React.useMemo(() => data.filter((n) => Number.isFinite(n)), [data]);

  const geom = React.useMemo(() => {
    if (points.length < 2 || width <= 0) return null;
    // Half a stroke of breathing room, so the end caps are not sliced off by
    // the card edge the way they were at x=0 and x=100.
    const inset = 1.9;
    const max = Math.max(...points);
    const min = Math.min(...points);
    const range = max - min || 1;
    const stepX = (width - inset * 2) / (points.length - 1);
    const usableH = height - inset * 2;

    const line = points
      .map((v, i) => {
        const x = inset + i * stepX;
        const y = inset + (1 - (v - min) / range) * usableH;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');

    return { line, area: `${line} L${(width - inset).toFixed(2)},${height} L${inset},${height} Z` };
  }, [points, width, height]);

  return (
    <div ref={ref} className="w-full" style={{ height }} aria-hidden>
      {geom && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
          <defs>
            <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={geom.area} fill={`url(#sp-${id})`} />
          <motion.path
            d={geom.line}
            fill="none"
            stroke={color}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: EASE }}
          />
        </svg>
      )}
    </div>
  );
}
