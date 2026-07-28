'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/cn';
import { formatDay, formatFullDate, formatNumber } from '@/lib/format';
import { useElementWidth } from '@/lib/useElementWidth';
import { useSeriesPalette, useTokens } from './charts';
import { EASE } from './ui';

export interface VendorTrendData {
  days: string[];
  series: { vendor: string; total: number; data: number[]; splits: Record<string, number>[] }[];
  totals: number[];
  totalSplits: Record<string, number>[];
  otherTotals: number[];
  hiddenVendorCount: number;
}

/** Left gutter holding the scale, and the bottom strip holding day numbers. */
const AXIS_W = 34;
const AXIS_GAP = 6;
const LABEL_H = 34;

/** Bar geometry, in pixels — every bar in the chart is given the same width. */
const BAR_GAP = 2;
/** Empty space kept between one day's group and the next. */
const GROUP_PAD = 10;
const MIN_BAR = 3;
const MAX_BAR = 18;
/** Below this, grouped bars stop being readable and the chart stacks instead. */
const COMFORTABLE_BAR = 6;

const MIN_COL = 5;
const MAX_COL = 34;

type Mode = 'grouped' | 'stacked';

/**
 * Vendor attendance over time: one column group per day, one bar per contractor
 * within it, and a panel showing whichever day you point at.
 *
 * Grouped rather than stacked by default. Stacking answers "how many
 * altogether", which the headline chart already does; the question here is "how
 * do the contractors compare on this day", and only a shared baseline lets you
 * read that. Every bar in a group starts at zero, so their heights are directly
 * comparable.
 *
 * Two things make that comparison honest. Every bar is drawn at the same
 * measured pixel width — a contractor keeps its slot on days it sent nobody, so
 * a thin bar always means a small number and never "there were more contractors
 * that day". And when the window is long enough that grouped bars would fall
 * below a few pixels each, the chart stacks instead of drawing hairlines; the
 * toggle overrides that in either direction.
 *
 * The side panel exists because the columns alone cannot carry nine labels and a
 * trade breakdown. Pointing at a day fills it in; pointing at one bar narrows it
 * to that contractor and dims the rest. Nothing is hidden behind a tooltip that
 * disappears the moment you look away.
 *
 * Drawn as positioned elements rather than through the chart library: the bars
 * need per-vendor hover, keyboard focus and a linked side panel, which is a lot
 * of fighting with a chart abstraction for a shape this simple.
 */
export function VendorAttendanceChart({
  trend,
  windowDays = 14,
  height = 300,
}: {
  trend: VendorTrendData;
  windowDays?: number;
  height?: number;
}) {
  const t = useTokens();
  const palette = useSeriesPalette();
  const reduced = useReducedMotion();
  // Bar width has to be a number, not a fraction: the whole point is that a
  // bar means the same thing on a day with two contractors as on a day with
  // eight, and only a measured plot area can guarantee that.
  const [plotRef, plotWidth] = useElementWidth<HTMLDivElement>();

  // The payload is always 30 days; show the tail that matches the picked window.
  const view = React.useMemo(() => {
    const offset = Math.max(0, trend.days.length - windowDays);
    return {
      days: trend.days.slice(offset),
      series: trend.series.map((s) => ({
        ...s,
        data: s.data.slice(offset),
        splits: s.splits.slice(offset),
      })),
      totals: trend.totals.slice(offset),
      totalSplits: trend.totalSplits.slice(offset),
      otherTotals: trend.otherTotals.slice(offset),
    };
  }, [trend, windowDays]);

  /**
   * Contractors who actually sent somebody inside this window, with their
   * original index kept so colour and focus stay stable. A vendor with nothing
   * in the period would otherwise hold an empty slot in every group and make
   * every bar thinner for no information.
   */
  const active = React.useMemo(
    () =>
      view.series
        .map((s, vendorIndex) => ({ s, vendorIndex }))
        .filter(({ s }) => s.data.some((n) => n > 0)),
    [view],
  );

  const lastIndex = Math.max(view.days.length - 1, 0);
  const [focusDay, setFocusDay] = React.useState(lastIndex);
  const [focusVendor, setFocusVendor] = React.useState<number | null>(null);
  /** null means "whatever fits"; a value means the reader has chosen. */
  const [modeOverride, setModeOverride] = React.useState<Mode | null>(null);

  // A new window means the old index may not exist any more.
  React.useEffect(() => {
    setFocusDay(Math.max(view.days.length - 1, 0));
    setFocusVendor(null);
  }, [view.days.length]);

  const day = Math.min(focusDay, lastIndex);
  const vendor = focusVendor == null ? null : (view.series[focusVendor] ?? null);
  const total = vendor ? (vendor.data[day] ?? 0) : (view.totals[day] ?? 0);
  const split = vendor ? (vendor.splits[day] ?? {}) : (view.totalSplits[day] ?? {});
  const other = view.otherTotals[day] ?? 0;

  // ---- Geometry ------------------------------------------------------------
  const dayCount = Math.max(view.days.length, 1);
  const vendorCount = Math.max(active.length, 1);
  const slotW = plotWidth > 0 ? plotWidth / dayCount : 0;

  // The gap between day groups is a share of the slot, capped: a flat 10px is a
  // third of the column on a narrow panel, which was enough to push a
  // comfortably groupable three-vendor week into stacking for no reason.
  const groupPad = Math.min(GROUP_PAD, slotW * 0.22);
  /** What one grouped bar could be, before it is clamped to something drawable. */
  const idealBar = (slotW - groupPad - (vendorCount - 1) * BAR_GAP) / vendorCount;
  const fits = idealBar >= COMFORTABLE_BAR;
  // Until the first measurement lands, assume grouped — it is what the reader
  // ends up with on every default range, so nothing flips on them.
  const mode: Mode = modeOverride ?? (plotWidth === 0 || fits ? 'grouped' : 'stacked');

  const barW = Math.max(MIN_BAR, Math.min(MAX_BAR, Math.floor(idealBar) || MIN_BAR));
  const colW = Math.max(MIN_COL, Math.min(MAX_COL, Math.floor(slotW - groupPad) || MIN_COL));

  /** Day totals over the drawn vendors only, which is what a stack adds up to. */
  const dayTotals = React.useMemo(
    () => view.days.map((_, i) => active.reduce((sum, { s }) => sum + (s.data[i] ?? 0), 0)),
    [view.days, active],
  );

  // Round the axis up to a clean multiple of five so the gridlines land on
  // readable numbers instead of whatever the peak happens to be.
  const peak =
    mode === 'stacked'
      ? Math.max(1, ...dayTotals)
      : Math.max(1, ...active.flatMap(({ s }) => s.data));
  const top = Math.max(5, Math.ceil(peak / 5) * 5);
  const ticks = [top, Math.round(top * 0.75), Math.round(top * 0.5), Math.round(top * 0.25), 0];

  const splitRows = Object.entries(split)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  /** Thin the day labels as the window grows, so they never collide. */
  const labelEvery = Math.max(1, Math.ceil(dayCount / (plotWidth > 0 ? plotWidth / 30 : 14)));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_260px]">
      {/* ---- Columns ---- */}
      <div className="min-w-0 lg:border-r lg:border-line">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 pb-3">
          {active.map(({ s, vendorIndex }) => (
            <button
              key={s.vendor}
              type="button"
              title={s.vendor}
              onClick={() => setFocusVendor((v) => (v === vendorIndex ? null : vendorIndex))}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] transition-opacity',
                focusVendor != null && focusVendor !== vendorIndex ? 'opacity-40' : 'opacity-100',
              )}
            >
              <span
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ background: palette[vendorIndex % palette.length] }}
              />
              <span className="max-w-[130px] truncate text-ink-muted">{s.vendor}</span>
            </button>
          ))}
          {trend.hiddenVendorCount > 0 && (
            <span className="text-[12px] text-ink-faint">+{trend.hiddenVendorCount} more</span>
          )}

          {/* Sits with the legend rather than in the panel header: it changes
              what the colours mean, not what the panel is about. */}
          <div className="ml-auto flex shrink-0 items-center rounded-lg border border-line bg-surface-sunken p-0.5">
            {(['grouped', 'stacked'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setModeOverride(m)}
                title={
                  m === 'grouped'
                    ? 'Compare contractors side by side'
                    : 'Stack contractors into one column per day'
                }
                className={cn(
                  'rounded-[6px] px-2 py-0.5 text-[12px] font-semibold capitalize transition-colors',
                  mode === m
                    ? 'bg-brand text-ink-onBrand'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 pb-4" style={{ height }}>
          <div className="relative h-full">
            {/* Gridlines and scale */}
            <div className="absolute inset-x-0 top-0" style={{ bottom: LABEL_H }}>
              {ticks.map((v, i) => (
                <div
                  key={v}
                  className="absolute inset-x-0 flex items-center"
                  style={{ top: `${(i / (ticks.length - 1)) * 100}%`, gap: AXIS_GAP }}
                >
                  <span
                    className="shrink-0 text-right text-[11px] tabular-nums text-ink-faint"
                    style={{ width: AXIS_W }}
                  >
                    {v}
                  </span>
                  <span className="h-px flex-1" style={{ background: t.grid }} />
                </div>
              ))}
            </div>

            {/* Day columns */}
            <div
              ref={plotRef}
              className="absolute inset-y-0 right-0 flex"
              style={{ left: AXIS_W + AXIS_GAP }}
            >
              {view.days.map((d, dayIndex) => {
                const focused = day === dayIndex;
                const dayTotal = dayTotals[dayIndex] ?? 0;
                const showLabel =
                  dayIndex % labelEvery === 0 || dayIndex === lastIndex || focused;

                return (
                  <div
                    key={d}
                    onPointerEnter={() => {
                      setFocusDay(dayIndex);
                      setFocusVendor(null);
                    }}
                    className="relative flex min-w-0 flex-1 flex-col"
                  >
                    {/* The focus wash is its own rounded rect rather than a
                        border on the cell — with gaps between groups, an edge
                        on every cell read as a table. */}
                    {focused && (
                      <motion.span
                        layoutId="vendor-day-focus"
                        aria-hidden
                        className="pointer-events-none absolute inset-x-px top-0 rounded-lg bg-brand-subtle"
                        style={{ bottom: LABEL_H - 8 }}
                        transition={{ duration: 0.18, ease: EASE }}
                      />
                    )}

                    <div
                      className="relative flex min-h-0 flex-1 items-end justify-center"
                      style={{ gap: mode === 'grouped' ? BAR_GAP : 0 }}
                    >
                      {mode === 'grouped'
                        ? active.map(({ s, vendorIndex }) => {
                            const value = s.data[dayIndex] ?? 0;
                            // A day this contractor missed still holds its slot,
                            // so the bar under a legend swatch is always in the
                            // same place across the whole window.
                            if (value <= 0) {
                              return (
                                <span
                                  key={s.vendor}
                                  aria-hidden
                                  className="shrink-0"
                                  style={{ width: barW }}
                                />
                              );
                            }
                            const dim = focusVendor != null && focusVendor !== vendorIndex;
                            return (
                              <motion.button
                                key={s.vendor}
                                type="button"
                                aria-label={`${s.vendor}, ${formatFullDate(d)}, ${value} people`}
                                onPointerEnter={(e) => {
                                  e.stopPropagation();
                                  setFocusDay(dayIndex);
                                  setFocusVendor(vendorIndex);
                                }}
                                onFocus={() => {
                                  setFocusDay(dayIndex);
                                  setFocusVendor(vendorIndex);
                                }}
                                className={cn(
                                  'relative shrink-0 overflow-hidden rounded-t-[3px] transition-opacity',
                                  dim ? 'opacity-25' : 'opacity-100',
                                )}
                                style={{
                                  width: barW,
                                  background: palette[vendorIndex % palette.length],
                                }}
                                initial={reduced ? false : { height: 0 }}
                                animate={{ height: `${Math.max((value / top) * 100, 1.5)}%` }}
                                transition={{
                                  duration: 0.55,
                                  ease: EASE,
                                  delay: reduced ? 0 : dayIndex * 0.022,
                                }}
                              >
                                {/* A light top edge gives the bar a little
                                    dimension without inventing a second hue. */}
                                <span
                                  aria-hidden
                                  className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/25 to-transparent"
                                />
                              </motion.button>
                            );
                          })
                        : dayTotal > 0 && (
                            <motion.div
                              className="flex shrink-0 flex-col-reverse overflow-hidden rounded-t-[4px]"
                              style={{ width: colW }}
                              initial={reduced ? false : { height: 0 }}
                              animate={{ height: `${Math.max((dayTotal / top) * 100, 1.5)}%` }}
                              transition={{
                                duration: 0.55,
                                ease: EASE,
                                delay: reduced ? 0 : dayIndex * 0.022,
                              }}
                            >
                              {active.map(({ s, vendorIndex }) => {
                                const value = s.data[dayIndex] ?? 0;
                                if (value <= 0) return null;
                                const dim = focusVendor != null && focusVendor !== vendorIndex;
                                return (
                                  <button
                                    key={s.vendor}
                                    type="button"
                                    aria-label={`${s.vendor}, ${formatFullDate(d)}, ${value} people`}
                                    onPointerEnter={(e) => {
                                      e.stopPropagation();
                                      setFocusDay(dayIndex);
                                      setFocusVendor(vendorIndex);
                                    }}
                                    onFocus={() => {
                                      setFocusDay(dayIndex);
                                      setFocusVendor(vendorIndex);
                                    }}
                                    className={cn(
                                      'w-full shrink-0 transition-opacity',
                                      dim ? 'opacity-25' : 'opacity-100',
                                    )}
                                    style={{
                                      height: `${(value / dayTotal) * 100}%`,
                                      background: palette[vendorIndex % palette.length],
                                    }}
                                  />
                                );
                              })}
                            </motion.div>
                          )}
                    </div>

                    <div
                      className="shrink-0 pt-2 text-center"
                      style={{ height: LABEL_H }}
                    >
                      <span
                        className={cn(
                          'text-[11px] tabular-nums',
                          focused ? 'font-bold text-ink' : 'text-ink-faint',
                        )}
                      >
                        {showLabel ? new Date(`${d}T00:00:00`).getDate() : ''}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ---- Focused day panel ---- */}
      <aside className="border-t border-line bg-surface-sunken p-4 lg:border-t-0">
        <p className="text-[12px] uppercase tracking-[0.08em] text-ink-faint">
          {formatDay(view.days[day])}
        </p>
        <p className="mt-0.5 truncate text-[13px] font-semibold text-ink" title={vendor?.vendor}>
          {vendor?.vendor ?? 'All vendors'}
        </p>

        <p className="mt-3 text-[32px] font-bold leading-none tabular-nums tracking-tight text-ink">
          {formatNumber(total)}
        </p>
        <p className="mt-1 text-[12px] text-ink-muted">
          {vendor ? 'people from this vendor' : 'people on site that day'}
        </p>

        {splitRows.length > 0 ? (
          <div className="mt-4">
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
              By trade
            </p>
            {/* Every trade, not a truncated six. The panel is the only place
                this breakdown appears, so hiding the tail behind a "+N more"
                just meant the answer was never on screen. It scrolls instead. */}
            <ul className="max-h-[190px] space-y-1 overflow-y-auto pr-1">
              {splitRows.map(([trade, n]) => (
                <li key={trade} className="flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate text-ink-muted" title={trade}>
                    {trade}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-ink">{n}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-4 text-[12px] text-ink-faint">Nobody on site that day.</p>
        )}

        {!vendor && other > 0 && (
          <p className="mt-3 border-t border-line pt-2 text-[12px] text-ink-faint">
            Includes {formatNumber(other)} from vendors outside the top {view.series.length}.
          </p>
        )}

        <p className="mt-4 text-[12px] text-ink-faint">
          {vendor ? 'Click the legend again to see all vendors.' : 'Point at a bar for one vendor.'}
        </p>
      </aside>
    </div>
  );
}
