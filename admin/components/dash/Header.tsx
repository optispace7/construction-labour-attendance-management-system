'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/cn';
import { Site } from '@/lib/types';
import { TOPBAR_H } from '@/lib/layout';
import {
  daySpan,
  formatFullDate,
  formatNumber,
  formatRelative,
  isoDay,
  shiftDays,
} from '@/lib/format';
import { useTokens } from './charts';
import { EASE } from './ui';

export interface DateRange {
  from: string;
  to: string;
}

const PRESETS = [
  { label: '7D', days: 7 },
  { label: '14D', days: 14 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
];

export function rangeForDays(days: number): DateRange {
  const today = isoDay(new Date());
  return { from: shiftDays(today, -(days - 1)), to: today };
}

const fieldCls =
  'h-9 rounded-lg border border-line bg-surface-sunken px-2.5 text-[13px] text-ink outline-none transition-colors hover:border-line-strong focus:border-brand';

/** Inside the grouped range control, so the inputs carry no border of their own. */
const dateCls = 'h-full px-2 text-[13px] text-ink outline-none transition-colors hover:bg-surface-hover';

function Segmented({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
}) {
  const span = daySpan(value.from, value.to);
  const atToday = value.to >= isoDay(new Date());
  const active = PRESETS.find((p) => p.days === span && atToday)?.label;

  return (
    <div className="flex h-9 items-center rounded-lg border border-line bg-surface-sunken p-0.5">
      {PRESETS.map((p) => {
        const on = active === p.label;
        return (
          <button
            key={p.label}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(rangeForDays(p.days))}
            className={cn(
              'relative rounded-[6px] px-2.5 py-1 text-[12px] font-semibold transition-colors',
              on ? 'text-ink-onBrand' : 'text-ink-muted hover:text-ink',
            )}
          >
            {/* The pill slides between presets rather than cutting, so the
                selection stays trackable at a glance. */}
            {on && (
              <motion.span
                layoutId="range-preset"
                className="absolute inset-0 rounded-[6px] bg-brand"
                transition={{ duration: 0.25, ease: EASE }}
              />
            )}
            <span className="relative">{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Controls({
  sites,
  siteId,
  onSiteChange,
  range,
  onRangeChange,
  stacked,
}: {
  sites: Site[] | undefined;
  siteId: string;
  onSiteChange: (v: string) => void;
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  stacked?: boolean;
}) {
  const span = daySpan(range.from, range.to);
  const atToday = range.to >= isoDay(new Date());
  const step = (dir: -1 | 1) =>
    onRangeChange({
      from: shiftDays(range.from, dir * span),
      to: shiftDays(range.to, dir * span),
    });

  return (
    <div className={cn('flex gap-2', stacked ? 'flex-col' : 'flex-wrap items-center')}>
      <select
        value={siteId}
        onChange={(e) => onSiteChange(e.target.value)}
        aria-label="Site"
        className={cn(fieldCls, 'pr-7', stacked ? 'w-full' : 'min-w-[150px]')}
      >
        <option value="all">All sites</option>
        {(sites ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.isActive ? '' : ' (disabled)'}
          </option>
        ))}
      </select>

      <Segmented value={range} onChange={onRangeChange} />

      {/* One bordered control: step back, the two dates, step forward. The
          arrows used to float beside the inputs on their own borders, which
          read as three crowded controls rather than one date range. */}
      <div
        className={cn(
          'flex h-9 items-stretch overflow-hidden rounded-lg border border-line bg-surface-sunken',
          stacked && 'w-full',
        )}
      >
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label="Previous period"
          className="grid w-9 shrink-0 place-items-center border-r border-line text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <Chevron />
        </button>
        <input
          type="date"
          aria-label="From"
          value={range.from}
          onChange={(e) => e.target.value && onRangeChange({ ...range, from: e.target.value })}
          className={cn(dateCls, stacked ? 'min-w-0 flex-1' : 'w-[132px]')}
        />
        <span className="grid w-3 shrink-0 place-items-center text-[12px] text-ink-faint">–</span>
        <input
          type="date"
          aria-label="To"
          value={range.to}
          onChange={(e) => e.target.value && onRangeChange({ ...range, to: e.target.value })}
          className={cn(dateCls, stacked ? 'min-w-0 flex-1' : 'w-[132px]')}
        />
        <button
          type="button"
          onClick={() => step(1)}
          disabled={atToday}
          aria-label="Next period"
          title={atToday ? 'Already at the latest period' : 'Next period'}
          className="grid w-9 shrink-0 place-items-center border-l border-line text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Chevron className="rotate-180" />
        </button>
      </div>
    </div>
  );
}

/**
 * The dashboard's masthead: what you are looking at, whether it is fresh, and —
 * once you have scrolled past it — the one number the page exists to report.
 *
 * It pins under the app's top bar and condenses rather than scrolling away. On
 * a five-section page the headline figure was visible for the first screenful
 * and then gone, which is the wrong way round for a display somebody glances at
 * from across a site office. Condensed, it keeps the title, the live state and
 * the count in about a third of the height.
 *
 * The headline is deliberately absent at rest: the KPI cards sit directly
 * underneath and already say it. It appears only once they have scrolled off,
 * so it fills a gap rather than repeating a neighbour.
 *
 * Deliberately carries no filters. They live in [DashboardFilters], placed
 * directly above the first graph they change, so the control sits with its
 * effect instead of floating at the top of the page.
 */
export function DashboardHeader({
  sites,
  siteId,
  range,
  onRefresh,
  refreshing,
  lastUpdated,
  onExport,
  headline,
}: {
  sites: Site[] | undefined;
  siteId: string;
  range: DateRange;
  onRefresh: () => void;
  refreshing?: boolean;
  lastUpdated: Date | null;
  onExport?: () => void;
  /** Shown only in the condensed state. Null while it is still loading. */
  headline?: { value: number | null; label: string };
}) {
  const [, tick] = React.useReducer((n: number) => n + 1, 0);
  const [stuck, setStuck] = React.useState(false);
  const { mode } = useTokens();

  // Keeps "3m ago" honest without re-fetching anything.
  React.useEffect(() => {
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    // Passive: this runs on every scroll frame and must never be able to
    // block it.
    const onScroll = () => setStuck(window.scrollY > 88);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const siteName =
    siteId === 'all' ? 'All sites' : (sites?.find((s) => s.id === siteId)?.name ?? 'Selected site');
  const period =
    range.from === range.to
      ? formatFullDate(range.from)
      : `${formatFullDate(range.from)} – ${formatFullDate(range.to)}`;

  return (
    <header
      // The negative margins pull the bar out to the full width of the main
      // column, so the blurred backdrop reaches the edges instead of stopping
      // at the page padding and leaving two clear strips.
      className={cn(
        '-mx-4 mb-6 px-4 md:-mx-6 md:px-6',
        'sticky z-10 border-b transition-[padding,background-color,border-color,box-shadow] duration-200 ease-out',
        stuck ? 'border-line py-2.5 backdrop-blur-[10px]' : 'border-line pb-5 pt-1',
      )}
      style={{
        top: TOPBAR_H,
        // Tailwind cannot fold an alpha into `var(--clams-bg)`, so the
        // translucent state is written out rather than expressed as `bg-page/85`
        // — which silently emits nothing.
        background: stuck
          ? mode === 'dark'
            ? 'rgba(6,13,19,0.85)'
            : 'rgba(245,246,248,0.85)'
          : 'transparent',
        boxShadow: stuck ? 'var(--clams-shadow-card)' : 'none',
      }}
    >
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1
              className={cn(
                'truncate font-bold tracking-[-0.025em] text-ink transition-[font-size] duration-200 ease-out',
                stuck ? 'text-[17px]' : 'text-[26px] md:text-[30px]',
              )}
            >
              Workforce overview
            </h1>
            <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-positive/25 bg-positive-subtle px-2 py-0.5 text-[12px] font-bold text-positive sm:inline-flex">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-positive opacity-60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-positive" />
              </span>
              Live
            </span>
          </div>

          <AnimatePresence initial={false}>
            {!stuck && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18, ease: EASE }}
                className="overflow-hidden"
              >
                <p className="mt-1 text-[13px] text-ink-muted">
                  {siteName} · {period}
                </p>
                {lastUpdated && (
                  <p className="mt-1 text-[12px] text-ink-faint">
                    Last synchronised {formatRelative(lastUpdated)}
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {stuck && headline && headline.value !== null && (
            <motion.div
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.2, ease: EASE }}
              className="hidden shrink-0 items-baseline gap-2 sm:flex"
            >
              <span className="text-[22px] font-bold leading-none tabular-nums tracking-tight text-ink">
                {formatNumber(headline.value)}
              </span>
              <span className="text-[12px] text-ink-muted">{headline.label}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex shrink-0 items-center gap-2">
          {onExport && (
            <button
              type="button"
              onClick={onExport}
              title="Export this period"
              aria-label="Export this period"
              className="grid size-9 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              <DownloadIcon />
            </button>
          )}

          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh dashboard"
            className="grid size-9 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-60"
          >
            <RefreshIcon spinning={refreshing} />
          </button>
        </div>
      </div>
    </header>
  );
}

const Chevron = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={cn('size-4', className)} fill="none" stroke="currentColor" strokeWidth={1.8}>
    <path d="m10 4-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SlidersIcon = () => (
  <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="M2 5h9M13 5h1M2 11h3M7 11h7" strokeLinecap="round" />
    <circle cx="11.5" cy="5" r="1.6" />
    <circle cx="5.5" cy="11" r="1.6" />
  </svg>
);

const DownloadIcon = () => (
  <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.7}>
    <path d="M8 2v8m0 0L5 7m3 3 3-3M3 13h10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8}>
    <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
  </svg>
);

const RefreshIcon = ({ spinning }: { spinning?: boolean }) => (
  <svg
    viewBox="0 0 16 16"
    className={cn('size-4', spinning && 'animate-spin')}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
  >
    <path d="M14 8a6 6 0 1 1-1.8-4.3" strokeLinecap="round" />
    <path d="M14 2v4h-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);


/**
 * Site and reporting period, as one bar.
 *
 * Sits above the graphs it governs rather than in the page header — a filter
 * three sections away from what it changes is one people forget is set. Wraps
 * onto two rows on a narrow screen instead of collapsing into a sheet, which
 * costs a tap and hides the current selection.
 */
export function DashboardFilters({
  sites,
  siteId,
  onSiteChange,
  range,
  onRangeChange,
}: {
  sites: Site[] | undefined;
  siteId: string;
  onSiteChange: (v: string) => void;
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface px-3 py-2.5">
      <SlidersIcon />
      <span className="mr-1 hidden text-[12px] font-semibold text-ink-muted sm:inline">
        Showing
      </span>
      <Controls
        sites={sites}
        siteId={siteId}
        onSiteChange={onSiteChange}
        range={range}
        onRangeChange={onRangeChange}
      />
    </div>
  );
}
