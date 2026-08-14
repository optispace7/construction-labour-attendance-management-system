'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  Sector,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { motion, useReducedMotion } from 'framer-motion';
import { EASE } from '@/components/dash/ui';
import { formatDay, formatNumber, formatWeekday } from '@/lib/format';
import {
  cssSeries,
  cssToken,
  useAnimateOnce,
  useSeriesPalette,
  useTokens,
} from '@/components/dash/charts';
import { useElementWidth } from '@/lib/useElementWidth';

/**
 * The safety board's charts.
 *
 * The marks follow the shadcn/ui chart patterns — gradient-filled areas, a
 * hairline cursor rather than a shaded band, a donut whose centre answers the
 * hover, rounded bars sitting in their own track — but they are drawn straight
 * on Recharts against the `--clams-*` tokens rather than through shadcn's
 * `ChartContainer`. That component keys everything off Tailwind v4's
 * `--chart-1…5` variables and its own `cn`/Radix stack, none of which this
 * panel has; porting the *look* keeps the board matching every other admin
 * chart and still repainting with the theme toggle.
 *
 * Colours come from the panel's own categorical palette rather than the one the
 * client-facing PDF uses: this page sits beside every other admin chart and has
 * to match them, and it inherits light mode from the theme toggle, which the
 * PDF's dark-only palette was never stepped for.
 */

/** The shared tooltip surface, matching the workforce dashboard's. */
function TipShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-[168px] rounded-xl border border-line-strong bg-surface-elevated px-3 py-2.5 shadow-elevated backdrop-blur-sm">
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

/**
 * The hover card: every series at that point, then the total.
 *
 * The total row is what makes a three-series chart readable on hover — "42
 * inductions" means little until you know the day ran to 130 engagements — and
 * it is the one number a client asks for out loud. Hidden for single-series
 * charts, where it would just repeat the row above it.
 */
function SeriesTip({
  active,
  payload,
  label,
  total = true,
}: {
  active?: boolean;
  payload?: TipRow[];
  label?: string;
  total?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const sum = payload.reduce((a, p) => a + (p.value ?? 0), 0);
  return (
    <TipShell>
      {label && (
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
          {label}
        </p>
      )}
      {payload.map((p) => (
        <div
          key={String(p.dataKey ?? p.name)}
          className="flex items-center gap-2 py-0.5 text-[12px]"
        >
          <span
            className="size-2 shrink-0 rounded-full ring-2"
            style={{
              background: p.color,
              ['--tw-ring-color' as string]: `${p.color}33`,
            }}
          />
          <span className="text-ink-muted">{p.name}</span>
          <span className="ml-auto font-semibold tabular-nums text-ink">
            {formatNumber(Math.round(p.value ?? 0))}
          </span>
        </div>
      ))}
      {total && payload.length > 1 && (
        <div className="mt-1.5 flex items-center gap-2 border-t border-line pt-1.5 text-[12px]">
          <span className="font-medium text-ink-muted">Total</span>
          <span className="ml-auto font-bold tabular-nums text-ink">
            {formatNumber(Math.round(sum))}
          </span>
        </div>
      )}
    </TipShell>
  );
}

/**
 * A chart sized from a measured element rather than from ResponsiveContainer.
 *
 * These panels settle their width after the charts first mount, and Recharts
 * kept the stale scale for the plotted marks while the axis re-rendered at the
 * new width — bars drifting left of their own labels, and a trend line that
 * stopped short of the right edge. Measuring first and rendering only once a
 * real width is known removes the race rather than waiting it out.
 */
function Measured({
  height,
  children,
}: {
  height: number;
  children: (width: number) => React.ReactNode;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="w-full px-1" style={{ height }}>
      {width > 0 && children(width)}
    </div>
  );
}

/**
 * One series in the header strip: its swatch, its name and its period total.
 *
 * A legend that also carries the totals earns the row it occupies twice over —
 * the reader gets the answer to "how many inductions this month?" without
 * hovering anything — and clicking it drops the series out of the plot, which
 * is the only way to compare two lines when a third dwarfs both.
 */
function SeriesChip({
  label,
  color,
  total,
  on,
  dimmed,
  onToggle,
}: {
  label: string;
  color: string;
  total?: number;
  on: boolean;
  dimmed: boolean;
  onToggle?: () => void;
}) {
  const body = (
    <>
      {/* No tinted halo behind the dot: `color` is a `var()` now, and there is
          no way to append an alpha to one. The scale-on-hover carries the same
          affordance. */}
      <span
        aria-hidden
        className={`size-2.5 shrink-0 rounded-full transition-transform duration-200 group-hover:scale-125 ${
          on ? '' : 'opacity-60'
        }`}
        style={{ background: color }}
      />
      <span className="truncate text-[12px] text-ink-muted">{label}</span>
      {total !== undefined && (
        <span className="text-[12px] font-bold tabular-nums text-ink">{formatNumber(total)}</span>
      )}
    </>
  );

  if (!onToggle) {
    return <span className="group inline-flex items-center gap-1.5">{body}</span>;
  }
  return (
    // `appearance-none border-0 bg-transparent` is not decoration: Tailwind's
    // preflight is off in this app so MUI can keep its own baseline, which
    // leaves a bare <button> wearing the browser's default chrome — a grey
    // capsule with a border around every legend chip.
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={`group inline-flex cursor-pointer appearance-none items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-0.5 transition-opacity duration-200 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
        dimmed ? 'opacity-35' : 'opacity-100'
      }`}
    >
      {body}
    </button>
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
 * Areas rather than plain lines, and deliberately not stacked. Stacking would
 * give the prettier silhouette but it moves every series except the bottom one
 * onto a baseline that wanders, so a flat month of toolbox talks appears to
 * rise and fall with inductions underneath it. Each series keeps its own
 * baseline; the gradient fades out fast enough that three of them overlap
 * without turning to mud, and the fill is what stops a two-pixel line from
 * disappearing on a wall display across a site office.
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
  const reduced = useReducedMotion();
  const animate = useAnimateOnce(!reduced);
  const useWeekday = days.length <= 14;
  const gid = React.useId().replace(/:/g, '');

  /** Series switched off by clicking their chip. Empty means "show all". */
  const [hidden, setHidden] = React.useState<string[]>([]);
  const toggle = (metric: string) =>
    setHidden((h) => (h.includes(metric) ? h.filter((m) => m !== metric) : [...h, metric]));

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

  const totals = React.useMemo(
    () => new Map(series.map((s) => [s.metric, s.values.reduce((a, b) => a + (b || 0), 0)])),
    [series],
  );

  // Everything hidden is the same as nothing hidden — an empty plot is a bug
  // report, not a filter. The chips have to un-dim with it, or the panel shows
  // three lines while claiming all three are switched off.
  const shown = series.filter((s) => !hidden.includes(s.metric));
  const allHidden = shown.length === 0;
  const visible = allHidden ? series : shown;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2">
        {series.map((s, i) => (
          <SeriesChip
            key={s.metric}
            label={s.label}
            color={cssSeries(i)}
            total={totals.get(s.metric)}
            on={allHidden || !hidden.includes(s.metric)}
            dimmed={!allHidden && hidden.includes(s.metric)}
            onToggle={() => toggle(s.metric)}
          />
        ))}
      </div>
      <Measured height={height}>
        {(w) => (
          <AreaChart
            accessibilityLayer
            data={data}
            width={w}
            height={height}
            margin={{ top: 10, right: 14, left: -14, bottom: 4 }}
          >
            <defs>
              {series.map((s, i) => {
                const c = palette[i % palette.length];
                return (
                  <linearGradient
                    key={s.metric}
                    id={`fill-${gid}-${i}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={c} stopOpacity={0.34} />
                    <stop offset="72%" stopColor={c} stopOpacity={0.04} />
                    <stop offset="100%" stopColor={c} stopOpacity={0} />
                  </linearGradient>
                );
              })}
            </defs>
            <CartesianGrid stroke={t.grid} strokeDasharray="3 4" vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
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
            <Tooltip
              content={<SeriesTip />}
              // A hairline down the day rather than a shaded column: the band
              // sat on top of the gradients and washed the colours out at the
              // exact moment the reader is trying to tell them apart.
              cursor={{
                stroke: t.label,
                strokeWidth: 1,
                strokeDasharray: '4 4',
              }}
              animationDuration={140}
            />
            {series.map((s, i) =>
              visible.includes(s) ? (
                <Area
                  key={s.metric}
                  type="monotone"
                  dataKey={s.metric}
                  name={s.label}
                  stroke={palette[i % palette.length]}
                  strokeWidth={2.25}
                  fill={`url(#fill-${gid}-${i})`}
                  fillOpacity={1}
                  // No dot per day — with three series and a month of columns
                  // that is ninety circles competing with the lines. The active
                  // dot carries a ring in the card colour so it reads as a
                  // marker sitting on the line rather than a fourth series.
                  dot={false}
                  activeDot={{ r: 4.5, strokeWidth: 2, stroke: t.surface }}
                  isAnimationActive={animate}
                  animationDuration={700}
                  animationEasing="ease-out"
                />
              ) : null,
            )}
          </AreaChart>
        )}
      </Measured>
    </div>
  );
}

/**
 * The month's safety score as a 270° dial, with the target marked on the arc.
 *
 * Replaces the generic attendance ring this card borrowed. That ring is a full
 * circle with no reference on it, which is the wrong instrument for a score
 * that only means anything against a target: it drew 84% and 91% as two
 * near-identical rings, and the one number a review meeting turns on — are we
 * above the line or under it — had to be worked out from the caption. Here the
 * open foot gives the scale a visible start and end, and the pointer says where
 * the line is. The same mark is drawn on the exported PDF, so the sheet a
 * client is handed and the screen it was read off agree.
 */
export function SafetyScoreDial({
  value,
  target,
  size = 132,
}: {
  /** 0–100, or null while it is still loading. */
  value: number | null;
  target: number;
  size?: number;
}) {
  const reduced = useReducedMotion();
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  const tone =
    value === null
      ? cssToken('border')
      : pct >= target
        ? cssToken('positive')
        : pct >= target - 15
          ? cssToken('warning')
          : cssToken('critical');

  const START = 135;
  const SPAN = 270;
  const R = 36;
  const at = (deg: number, rad = R) => {
    const a = (deg * Math.PI) / 180;
    return [50 + rad * Math.cos(a), 50 + rad * Math.sin(a)] as const;
  };
  const arc = (from: number, to: number) => {
    const [x0, y0] = at(from);
    const [x1, y1] = at(to);
    return `M ${x0} ${y0} A ${R} ${R} 0 ${Math.abs(to - from) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const track = arc(START, START + SPAN);

  const ta = START + (SPAN * Math.max(0, Math.min(100, target))) / 100;
  const [tipX, tipY] = at(ta, R + 5.5);
  const [b1x, b1y] = at(ta - 4.5, R + 11);
  const [b2x, b2y] = at(ta + 4.5, R + 11);

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="size-full overflow-visible" aria-hidden>
          {/* The unfilled remainder rides on `border`, not `surface-sunken`:
              the sunken token is a hair off white in light mode, which left the
              track — and so the whole scale the score is read against —
              invisible on a white card. */}
          <path
            d={track}
            fill="none"
            style={{ stroke: cssToken('border') }}
            strokeWidth={8}
            strokeLinecap="round"
          />
          {/*
            The colour sits on a plain <g> and the arc inherits it.

            `stroke` is an inherited SVG property, and that is the whole trick:
            it has to reach the element as CSS, because an SVG presentation
            *attribute* will not resolve a `var()`. A `style` prop on a
            motion.path is not a safe place to put it — framer-motion rebuilds
            an SVG element's style and attributes from its own render state, so
            the declaration is not guaranteed to survive as CSS, and when it
            does not the arc falls back to no stroke at all and vanishes.

            The sweep is framer's own `pathLength`, a 0–1 fraction. Passing
            `pathLength={100}` alongside a hand-rolled strokeDasharray was two
            mechanisms fighting over the same attributes: framer normalises the
            path to one unit and writes the dash array itself, so a value of
            100 asked it to draw the arc a hundred times over and the ring came
            out full whatever the score was.
          */}
          <g style={{ stroke: tone }}>
            <motion.path
              d={track}
              fill="none"
              strokeWidth={8}
              strokeLinecap="round"
              initial={reduced ? false : { pathLength: 0 }}
              animate={{ pathLength: pct / 100 }}
              transition={{ duration: 0.9, ease: EASE }}
            />
          </g>
          <polygon
            points={`${tipX},${tipY} ${b1x},${b1y} ${b2x},${b2y}`}
            style={{ fill: cssToken('text-secondary') }}
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[28px] font-bold leading-none tabular-nums tracking-tight text-ink">
            {value === null ? '–' : `${Math.round(value)}%`}
          </span>
          <span className="mt-1 text-[11px] text-ink-muted">score</span>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">Target ≥ {target}%</p>
    </div>
  );
}

export interface SliceRow {
  key: string;
  label: string;
  value: number;
}

/**
 * A donut whose centre answers the hover, plus the rows beside it.
 *
 * The ring is only ever asked to show rough proportion — the rows carry the
 * numbers, so no one has to measure one slice against another. What the ring
 * does earn is the middle: resting it shows the total, and pointing at a slice
 * swaps it for that slice's own figure. That turns the hole in the doughnut
 * from decoration into the readout, which is the single change that makes this
 * chart look considered rather than generated.
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
  const reduced = useReducedMotion();
  const animate = useAnimateOnce(!reduced);
  const total = rows.reduce((a, b) => a + b.value, 0);
  const data = rows.filter((r) => r.value > 0);
  const gid = React.useId().replace(/:/g, '');

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  /** Which slice the pointer is on, from the ring *or* from a legend row. */
  const [active, setActive] = React.useState<string | null>(null);
  const activeIndex = data.findIndex((r) => r.key === active);
  const activeRow = activeIndex >= 0 ? data[activeIndex] : null;

  // A slice's colour has to follow the row it belongs to, not its position in
  // the filtered list — otherwise hiding a zero row silently recolours every
  // slice after it, and the ring stops agreeing with the legend beneath it.
  const colorOf = (key: string) => {
    const i = rows.findIndex((r) => r.key === key);
    return cssSeries(i < 0 ? 0 : i);
  };

  return (
    // Stacked, never side by side. These panels are a third of the page wide,
    // and a legend sharing that row with the ring got about ninety pixels —
    // enough to render "Unsafe conditions" as "Unsa…", which tells the reader
    // nothing. Below the ring the labels get the full width.
    <div className="flex min-w-0 flex-col gap-3 px-5 pb-4">
      <div style={{ height, width: height }} className="relative mx-auto shrink-0">
        {/* The ring's box is a fixed square, so it can be sized directly — and
            because it needs no measuring, it was the one chart on this page
            that actually server-rendered. That is a trap here: the server has
            no theme and draws the dark palette, and React 18 reports a
            mismatched colour prop without ever patching the attribute, so on a
            light page the slices kept dark-mode hues while the legend dots
            beneath them went light. Holding the ring back to the client keeps
            every mark on this page painted by the same palette. */}
        {mounted && (
          <PieChart width={height} height={height}>
            <defs>
              {rows.map((r, i) => {
                const c = palette[i % palette.length];
                return (
                  <linearGradient key={r.key} id={`slice-${gid}-${i}`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor={c} stopOpacity={1} />
                    <stop offset="100%" stopColor={c} stopOpacity={0.72} />
                  </linearGradient>
                );
              })}
            </defs>
            <Pie
              data={data.length ? data : [{ key: 'none', label: 'None', value: 1 }]}
              dataKey="value"
              nameKey="label"
              innerRadius="63%"
              outerRadius="90%"
              paddingAngle={data.length > 1 ? 2.5 : 0}
              cornerRadius={4}
              // The stroke is the card colour, not a border colour: it cuts the
              // segments apart rather than outlining them, which is what gives
              // the ring its floating look in either theme.
              stroke={t.surface}
              strokeWidth={2}
              activeIndex={activeIndex >= 0 ? activeIndex : undefined}
              activeShape={(props: unknown) => {
                const p = props as React.ComponentProps<typeof Sector>;
                return <Sector {...p} outerRadius={(p.outerRadius ?? 0) + 7} />;
              }}
              onMouseEnter={(_: unknown, i: number) => setActive(data[i]?.key ?? null)}
              onMouseLeave={() => setActive(null)}
              isAnimationActive={animate}
              animationDuration={720}
            >
              {(data.length ? data : [{ key: 'none' }]).map((r) => {
                const i = rows.findIndex((x) => x.key === r.key);
                return (
                  <Cell
                    key={r.key}
                    fill={data.length ? `url(#slice-${gid}-${i < 0 ? 0 : i})` : t.sunken}
                  />
                );
              })}
            </Pie>
          </PieChart>
        )}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          {/* Capped to the hole, not to the ring's box: "Unsafe conditions" set
              across the full width ran out over the slices on both sides. */}
          <div className="mx-auto text-center" style={{ maxWidth: Math.round(height * 0.58) }}>
            <p
              className="text-[24px] font-bold leading-none tabular-nums tracking-tight transition-colors duration-200"
              style={{ color: activeRow ? colorOf(activeRow.key) : undefined }}
            >
              <span className={activeRow ? '' : 'text-ink'}>
                {formatNumber(activeRow ? activeRow.value : total)}
              </span>
            </p>
            <p className="mt-1 line-clamp-2 text-[11px] leading-tight text-ink-faint">
              {activeRow ? activeRow.label : centreLabel}
            </p>
          </div>
        </div>
      </div>

      {/* `list-none` and the zeroed padding for the same reason the chips reset
          their own button styling — with preflight off, this list draws the
          browser's bullets and its 40px indent. */}
      <ul className="m-0 min-w-0 flex-1 list-none space-y-0.5 p-0">
        {rows.map((r, i) => {
          const share = total > 0 ? (r.value / total) * 100 : 0;
          const on = active === r.key;
          return (
            <li
              key={r.key}
              onMouseEnter={() => r.value > 0 && setActive(r.key)}
              onMouseLeave={() => setActive(null)}
              className={`min-w-0 rounded-lg px-1.5 py-1 transition-colors duration-150 ${
                on ? 'bg-surface-hover' : ''
              }`}
            >
              <div className="flex min-w-0 items-center gap-2 text-[13px]">
                <span
                  className="size-2.5 shrink-0 rounded-full transition-transform duration-200"
                  style={{
                    background: cssSeries(i),
                    transform: on ? 'scale(1.3)' : undefined,
                  }}
                />
                <span className="min-w-0 flex-1 truncate text-ink-muted" title={r.label}>
                  {r.label}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-ink">
                  {formatNumber(r.value)}
                </span>
                <span className="w-9 shrink-0 text-right tabular-nums text-ink-faint">
                  {Math.round(share)}%
                </span>
              </div>
              {/* The share again as a length. Two hundred against sixty is a
                  pair of numbers; it is only obviously three times as much once
                  something is three times as long. */}
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line/70">
                <div
                  className="h-full rounded-full transition-[width,opacity] duration-500 ease-out"
                  style={{
                    width: `${share}%`,
                    background: cssSeries(i),
                    opacity: on ? 1 : 0.65,
                  }}
                />
              </div>
            </li>
          );
        })}
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
 * Raised against closed, for the day, the week and the month.
 *
 * One meter per window rather than three pairs of columns on a shared axis.
 * The three windows are nested — today sits inside this week, which sits inside
 * this month — so a common scale was never comparing like with like: the
 * monthly column is tall by construction, and the daily pair it dwarfs
 * flattened to two nubs a couple of pixels high that nobody could read a
 * closure rate off. Giving each window its own track puts every row at full
 * length and makes the one figure that *is* comparable across them — the share
 * closed — the length of the bar.
 *
 * Two status hues rather than two categorical ones: "raised" and "closed" are
 * states of the same finding, not two different things being counted. The track
 * is everything raised; the fill is the part shut.
 *
 * The fill is clamped at the full track but the percentage is not. Closures are
 * counted in the window they happen in, not the window the finding was opened
 * in, so a quiet week that tidies up a busy one genuinely closes more than it
 * raised — the bar simply reads "full" and the number says 130%.
 */
export function ObservationBars({
  rows,
  height = 240,
}: {
  rows: ObservationRow[];
  height?: number;
}) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const animate = useAnimateOnce(!reduced);

  const totals = rows.reduce(
    (a, r) => ({ raised: a.raised + r.raised, closed: a.closed + r.closed }),
    { raised: 0, closed: 0 },
  );

  return (
    <div className="flex min-w-0 flex-col" style={{ height }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-1">
        <SeriesChip
          label="Raised"
          color={cssToken('warning')}
          total={totals.raised}
          on
          dimmed={false}
        />
        <SeriesChip
          label="Closed"
          color={cssToken('positive')}
          total={totals.closed}
          on
          dimmed={false}
        />
      </div>

      <ul className="m-0 flex min-w-0 flex-1 list-none flex-col justify-around gap-1 p-0 px-5 pb-4">
        {rows.map((r) => {
          const rate = r.raised > 0 ? (r.closed / r.raised) * 100 : null;
          const fill = rate === null ? 0 : Math.min(100, rate);
          return (
            <li key={r.bucket} className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="text-[14px] font-semibold text-ink">{r.bucket}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
                  {formatNumber(r.closed)} closed of {formatNumber(r.raised)} raised
                </span>
                <span
                  className="shrink-0 text-[17px] font-bold tabular-nums"
                  style={{
                    color:
                      rate === null
                        ? undefined
                        : cssToken(rate >= 85 ? 'positive' : rate >= 60 ? 'warning' : 'critical'),
                  }}
                >
                  {rate === null ? (
                    <span className="text-ink-faint">–</span>
                  ) : (
                    `${Math.round(rate)}%`
                  )}
                </span>
              </div>
              {/* The track is the raised total, so a full bar means a clean
                  window whatever the volume behind it. */}
              <div
                className="relative mt-2 h-3 overflow-hidden rounded-full"
                style={{
                  background: `rgb(var(--clams-warning-rgb) / 0.18)`,
                  boxShadow: `inset 0 0 0 1px ${cssToken('border')}`,
                }}
                role="img"
                aria-label={`${r.bucket}: ${r.closed} of ${r.raised} observations closed`}
              >
                {/* Only the entrance is animated. A width transition that fired
                    on every refetch would make a board left up on a site-office
                    wall twitch all day. */}
                <motion.div
                  className="h-full rounded-full"
                  style={{
                    background: `linear-gradient(90deg, rgb(var(--clams-positive-rgb) / 0.7), ${cssToken('positive')})`,
                  }}
                  initial={animate ? { width: 0 } : false}
                  animate={{ width: `${fill}%` }}
                  transition={{ duration: 0.7, ease: EASE }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
