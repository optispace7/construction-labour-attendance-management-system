'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/cn';
import { donutPalette } from '@/theme/tokens';
import { formatNumber, formatPercent, percentValue } from '@/lib/format';
import { useElementWidth } from '@/lib/useElementWidth';

/** Turns a hex colour into an rgba() string at the given alpha. */
function fade(hex: string, alpha: number) {
  const n = hex.replace('#', '');
  const v = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  const int = parseInt(v, 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

/**
 * Each contractor's share of total attendance, as a donut beside a ranked table.
 *
 * A donut is the right shape *here* and almost nowhere else on this dashboard.
 * The question is "what proportion of the workforce came from each contractor",
 * which is a part-to-whole reading of a single total — the one job a ring does
 * well. Everywhere else the question is a comparison or a ranking, which is why
 * those panels are bars.
 *
 * The table beside it does the work the ring cannot: exact figures, full names,
 * and a share bar for the fine differences that neighbouring angles hide.
 * Pointing at either side highlights the other, so the colour only has to be
 * learned once.
 *
 * Drawn with a conic-gradient rather than SVG arcs — one CSS property for the
 * whole ring, with small transparent wedges between slices so adjacent segments
 * stay distinguishable even when two are nearly the same size.
 */
export function VendorDonut({
  rows,
  totalLabel = 'TOTAL ATTENDANCE',
  maxSlices = 6,
}: {
  rows: { vendor: string; count: number }[];
  totalLabel?: string;
  maxSlices?: number;
}) {
  const reduced = useReducedMotion();
  const [active, setActive] = React.useState<number | null>(null);

  const { slices, total } = React.useMemo(() => {
    const clean = rows
      .filter((r) => Number.isFinite(r.count) && r.count > 0)
      .sort((a, b) => b.count - a.count);
    const head = clean.slice(0, maxSlices);
    // Everything past the top few becomes one slice, so the ring still adds up
    // to the total printed in the middle.
    const rest = clean.slice(maxSlices).reduce((sum, r) => sum + r.count, 0);
    return {
      slices: rest > 0 ? [...head, { vendor: 'Other vendors', count: rest }] : head,
      total: clean.reduce((sum, r) => sum + r.count, 0),
    };
  }, [rows, maxSlices]);

  const gradient = React.useMemo(() => {
    if (!total || slices.length === 0) return null;
    let cursor = 0;
    const stops = slices.map((row, i) => {
      const start = cursor;
      const end = cursor + (row.count / total) * 360;
      cursor = end;
      // A hairline gap, scaled to the slice so a 1% sliver is not erased by it.
      const gap = Math.min(1.4, Math.max((end - start) * 0.08, 0.35));
      const base = donutPalette[i % donutPalette.length];
      const colour = active === null || active === i ? base : fade(base, 0.16);
      const a = start + gap;
      const b = Math.max(a, end - gap);
      return `${colour} ${a}deg ${b}deg, transparent ${b}deg ${end}deg`;
    });
    return `conic-gradient(from -28deg, ${stops.join(', ')})`;
  }, [slices, total, active]);

  const selected = active === null ? null : (slices[active] ?? null);

  const [boxRef, boxWidth] = useElementWidth<HTMLDivElement>();
  // 210px ring + 20px gap + 40px padding leaves ~200px of table below this,
  // which is where the contractor names start losing their second word.
  const wide = boxWidth >= 470;

  if (!total || slices.length === 0) {
    return (
      <div className="flex min-h-[240px] items-center justify-center px-6 text-center">
        <p className="text-[13px] text-ink-muted">No attendance recorded in this period.</p>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      // Side by side only once the panel is genuinely wide — measured, not
      // guessed from a viewport breakpoint. `2xl:` is true on a 1600px screen
      // while this card, sitting in a third of a column beside a 258px nav
      // rail, is about 430px across: the table then got ~170px and collapsed
      // every contractor to "S." with the column headings overlapping.
      className={cn(
        'grid items-center gap-5 px-5 py-4',
        wide ? 'grid-cols-[210px_minmax(0,1fr)]' : 'grid-cols-1',
      )}
      // The same fine grid the rest of the dark theme uses, so the panel reads
      // as part of the surface rather than a cut-out.
      style={{
        backgroundImage:
          'linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)',
        backgroundSize: '28px 28px',
      }}
    >
      {/* ---- Ring ---- */}
      <div className="flex justify-center">
        <motion.div
          role="img"
          aria-label={`Attendance by vendor. ${slices
            .map((s) => `${s.vendor}: ${s.count}, ${formatPercent(s.count, total)}`)
            .join('. ')}`}
          className="relative aspect-square w-[200px] rounded-full sm:w-[216px]"
          style={{
            background: gradient ?? undefined,
            filter: 'drop-shadow(0 14px 24px rgba(0,0,0,0.28))',
          }}
          initial={reduced ? false : { rotate: -14, opacity: 0, scale: 0.94 }}
          animate={{ rotate: 0, opacity: 1, scale: 1 }}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Hub. Punches the ring out and carries the reading. */}
          <div className="absolute inset-[29%] flex flex-col items-center justify-center rounded-full border border-white/10 bg-page text-center shadow-[inset_0_0_24px_rgba(0,0,0,0.5)] ring-[7px] ring-white/[0.03]">
            <span className="line-clamp-2 max-w-[92px] px-1 text-[11px] uppercase leading-tight tracking-wide text-ink-muted">
              {selected?.vendor ?? totalLabel}
            </span>
            <span className="mt-1 text-[25px] font-bold leading-none tabular-nums text-ink">
              {formatNumber(selected?.count ?? total)}
            </span>
            {selected && (
              <span
                className="mt-1 text-[12px] font-bold tabular-nums"
                style={{ color: donutPalette[active! % donutPalette.length] }}
              >
                {formatPercent(selected.count, total)}
              </span>
            )}
          </div>
        </motion.div>
      </div>

      {/* ---- Ranked table ---- */}
      <div className="min-w-0">
        <div className="grid grid-cols-[minmax(0,1fr)_50px_58px] gap-2 border-b border-line pb-2 text-[12px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
          <span>Vendor</span>
          <span className="text-right">Share</span>
          {/* "Attendance" no longer fits its column at 12px, and widening the
              column would come straight out of the vendor names, which already
              truncate in a third-width panel. The figure is a headcount and the
              panel says so above. */}
          <span className="text-right">People</span>
        </div>

        <ul>
          {slices.map((row, i) => {
            const colour = donutPalette[i % donutPalette.length];
            const pct = percentValue(row.count, total) ?? 0;
            const dim = active !== null && active !== i;
            return (
              <li key={row.vendor}>
                <button
                  type="button"
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_50px_58px] items-center gap-2 border-b border-line/60 py-2.5 transition-opacity',
                    dim ? 'opacity-40' : 'opacity-100',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-sm"
                      style={{ background: colour }}
                    />
                    <span className="truncate text-[13px] font-medium text-ink" title={row.vendor}>
                      {row.vendor}
                    </span>
                  </span>
                  <span
                    className="text-right text-[12px] font-bold tabular-nums"
                    style={{ color: colour }}
                  >
                    {Math.round(pct)}%
                  </span>
                  <span className="text-right text-[13px] font-bold tabular-nums text-ink">
                    {formatNumber(row.count)}
                  </span>

                  {/* The share bar sits under the row, spanning the name and
                      share columns — it separates the 15%s that the ring puts
                      at indistinguishable angles. */}
                  <span className="col-span-2 -mt-1 block h-[3px] overflow-hidden rounded-full bg-surface-sunken">
                    <motion.span
                      className="block h-full rounded-full"
                      style={{ background: colour }}
                      initial={reduced ? false : { width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{
                        duration: 0.65,
                        ease: [0.22, 1, 0.36, 1],
                        delay: 0.12 + i * 0.05,
                      }}
                    />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
