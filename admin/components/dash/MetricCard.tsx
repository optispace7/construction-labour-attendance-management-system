'use client';

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/cn';
import { formatNumber, formatRelative, NO_VALUE } from '@/lib/format';
import { EASE, Panel, Skeleton } from './ui';
import { Sparkline, useTokens } from './charts';

export type Tone = 'brand' | 'positive' | 'warning' | 'critical' | 'info' | 'neutral';

/** Literal class strings — Tailwind cannot see a template-built class name. */
const TONE = {
  brand: { text: 'text-brand', chip: 'bg-brand-subtle text-brand', ring: 'ring-brand/25' },
  positive: {
    text: 'text-positive',
    chip: 'bg-positive-subtle text-positive',
    ring: 'ring-positive/25',
  },
  warning: { text: 'text-warning', chip: 'bg-warning-subtle text-warning', ring: 'ring-warning/25' },
  critical: {
    text: 'text-critical',
    chip: 'bg-critical-subtle text-critical',
    ring: 'ring-critical/25',
  },
  info: { text: 'text-info', chip: 'bg-info-subtle text-info', ring: 'ring-info/25' },
  neutral: { text: 'text-ink-faint', chip: 'bg-surface-sunken text-ink-muted', ring: 'ring-line' },
} as const;

/**
 * Counts a value up on first paint.
 *
 * Short and eased-out so the number is readable almost immediately — the point
 * is to draw the eye to what changed, not to make anyone wait to read it. Skips
 * the animation for tiny changes, where it is just a flicker, and for anyone who
 * has asked their system to reduce motion.
 */
function useCountUp(value: number | null, duration = 700) {
  const [display, setDisplay] = React.useState(value ?? 0);
  const previous = React.useRef<number | null>(null);
  const reduced = useReducedMotion();

  React.useEffect(() => {
    if (value === null || !Number.isFinite(value)) return;
    const from = previous.current ?? 0;
    previous.current = value;

    if (reduced || Math.abs(value - from) < 2) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(Math.round(from + (value - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);

  return value === null ? null : display;
}

export interface Pulse {
  /** Distinguishes consecutive changes so the animation replays. */
  id: number;
  delta: number;
  direction: 'up' | 'down';
}

/**
 * Announces that a figure changed *while you were looking at it*.
 *
 * The dashboard polls every thirty seconds and, until now, numbers simply
 * swapped underneath the reader. On a wall display in a site office that is the
 * whole point of the screen — somebody scanned in — and it was the one event the
 * page never mentioned. This surfaces the delta for a moment and then gets out
 * of the way.
 *
 * Deliberately silent on the first value: arriving at a page is not a change,
 * and flashing every card on load would train people to ignore the flash.
 */
function useChangePulse(value: number | null) {
  const previous = React.useRef<number | null>(null);
  const seq = React.useRef(0);
  const [pulse, setPulse] = React.useState<Pulse | null>(null);

  React.useEffect(() => {
    if (value === null || !Number.isFinite(value)) return;
    const before = previous.current;
    previous.current = value;
    if (before === null || before === value) return;

    seq.current += 1;
    setPulse({
      id: seq.current,
      delta: value - before,
      direction: value > before ? 'up' : 'down',
    });
    const t = setTimeout(() => setPulse(null), 2600);
    return () => clearTimeout(t);
  }, [value]);

  return pulse;
}

/** Whether a change in this direction is good news for this particular metric. */
function pulseTone(direction: 'up' | 'down', sentiment: 'normal' | 'invert' | 'neutral' = 'normal') {
  if (sentiment === 'neutral') return 'brand' as const;
  const good = sentiment === 'invert' ? direction === 'down' : direction === 'up';
  return good ? ('positive' as const) : ('critical' as const);
}

/**
 * Period-over-period change, as a count rather than a percentage.
 *
 * "6 more than yesterday" is what a site manager acts on; "18%" makes them work
 * out the headcount before it means anything, and on small numbers a percentage
 * swings wildly for no real change.
 *
 * Direction sets the colour, but not blindly: fewer missed check-outs is good
 * news, so `invert` lets a falling number read as positive. A metric where a
 * change carries no judgement (headcount) passes `neutral`.
 */
export function Trend({
  change,
  label,
  sentiment = 'normal',
}: {
  change: { delta: number; direction: 'up' | 'down' | 'flat' } | null;
  label?: string;
  sentiment?: 'normal' | 'invert' | 'neutral';
}) {
  if (!change) {
    return <span className="text-[12px] text-ink-faint">{label ?? 'No comparison'}</span>;
  }

  const good =
    sentiment === 'neutral'
      ? null
      : sentiment === 'invert'
        ? change.direction === 'down'
        : change.direction === 'up';

  const cls =
    change.direction === 'flat' || good === null
      ? 'bg-surface-sunken text-ink-muted'
      : good
        ? 'bg-positive-subtle text-positive'
        : 'bg-critical-subtle text-critical';

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        className={cn(
          'inline-flex items-center gap-0.5 rounded px-1.5 py-px text-[12px] font-bold tabular-nums',
          cls,
        )}
      >
        <Arrow direction={change.direction} />
        {change.direction === 'flat' ? '0' : formatNumber(Math.abs(change.delta))}
      </span>
      {label && <span className="truncate text-[12px] text-ink-muted">{label}</span>}
    </span>
  );
}

function Arrow({ direction }: { direction: 'up' | 'down' | 'flat' }) {
  if (direction === 'flat') {
    return (
      <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="M2.5 6h7" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 12 12"
      className={cn('size-3', direction === 'down' && 'rotate-180')}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A headline number with its context.
 *
 * Cards are not uniform on purpose: `emphasis` promotes the two that matter most
 * into a larger, tinted treatment so the eye lands somewhere deliberate rather
 * than scanning an even row. The rest stay quiet.
 */
export function MetricCard({
  label,
  value,
  unit,
  icon,
  hint,
  tooltip,
  change,
  changeLabel,
  sentiment,
  spark,
  tone = 'brand',
  emphasis = false,
  loading = false,
  onClick,
  footer,
}: {
  label: string;
  /** null renders the no-value dash rather than a misleading zero. */
  value: number | null;
  unit?: string;
  icon?: React.ReactNode;
  hint?: string;
  tooltip?: string;
  change?: { delta: number; direction: 'up' | 'down' | 'flat' } | null;
  changeLabel?: string;
  sentiment?: 'normal' | 'invert' | 'neutral';
  spark?: number[];
  tone?: Tone;
  emphasis?: boolean;
  loading?: boolean;
  onClick?: () => void;
  footer?: React.ReactNode;
}) {
  const t = useTokens();
  const counted = useCountUp(loading ? null : value);
  const pulse = useChangePulse(loading ? null : value);
  const toneCls = TONE[tone];
  const sparkColor = {
    brand: t.brand,
    positive: t.positive,
    warning: t.warning,
    critical: t.critical,
    info: t.info,
    neutral: t.muted,
  }[tone];

  if (loading) {
    // Same silhouette as the real card: chip, label, value, hint. The panel
    // does not resize when the figures arrive.
    return (
      <Panel className="h-full p-5">
        <div className="mb-3 flex items-center gap-2">
          {/* The icon and its tone are known before the figure is — showing
              them is more honest than greying them out, and it stops the card
              re-colouring the instant data lands. */}
          {icon ? (
            <span
              className={cn(
                'grid size-8 shrink-0 place-items-center rounded-[10px] [&>svg]:size-[17px]',
                toneCls.chip,
              )}
            >
              {icon}
            </span>
          ) : (
            <Skeleton className="size-8 shrink-0 rounded-[10px]" />
          )}
          <Skeleton className="h-3 w-2/5" />
        </div>
        <Skeleton className={cn('rounded', emphasis ? 'h-9 w-28' : 'h-7 w-20')} />
        <Skeleton className="mt-3 h-2.5 w-3/5" />
      </Panel>
    );
  }

  const pulseTone_ = pulse ? pulseTone(pulse.direction, sentiment) : null;

  return (
    <Panel
      interactive={!!onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={cn(
        'group h-full overflow-hidden',
        onClick && 'cursor-pointer',
        emphasis && 'ring-1 ring-inset',
        emphasis && toneCls.ring,
      )}
    >
      {/* A wash in the tone of the change, held for a beat. This is the part
          that carries across a room, where a 13px delta chip does not. */}
      <AnimatePresence>
        {pulse && pulseTone_ && (
          <motion.span
            key={`flash-${pulse.id}`}
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: `radial-gradient(130% 110% at 50% 0%, ${
                { positive: t.positive, critical: t.critical, brand: t.brand }[pulseTone_]
              }26 0%, transparent 60%)`,
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: EASE }}
          />
        )}
      </AnimatePresence>

      {/* A wide, faint wash on the promoted cards — enough to lift them out of
          the row, not enough to read as decoration. */}
      {emphasis && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background: `radial-gradient(120% 100% at 0% 0%, ${sparkColor}22 0%, transparent 55%)`,
          }}
        />
      )}

      <div className="relative p-5">
        <div className="mb-3 flex min-w-0 items-center gap-2">
          {icon && (
            <span
              className={cn(
                'grid size-8 shrink-0 place-items-center rounded-[10px] [&>svg]:size-[17px]',
                toneCls.chip,
              )}
            >
              {icon}
            </span>
          )}
          <span className="min-w-0 truncate text-[12px] font-semibold text-ink-muted">{label}</span>
          {tooltip && (
            <span title={tooltip} className="shrink-0 cursor-help text-ink-faint">
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <circle cx="8" cy="8" r="6.25" />
                <path d="M8 7.2v4M8 5.1h.01" strokeLinecap="round" />
              </svg>
            </span>
          )}
        </div>

        <div className="flex items-baseline gap-1.5">
          <motion.span
            key={counted === null ? 'none' : 'v'}
            className={cn(
              'font-bold leading-none tabular-nums tracking-tight text-ink',
              emphasis ? 'text-[36px]' : 'text-[26px]',
            )}
          >
            {counted === null ? NO_VALUE : formatNumber(counted)}
          </motion.span>
          {unit && counted !== null && (
            <span className="text-[14px] font-semibold text-ink-muted">{unit}</span>
          )}

          {/* Rises out of the number and fades, the way a score does. Keyed on
              the pulse id so two changes in a row play twice rather than the
              second being swallowed by the first still being on screen. */}
          <AnimatePresence>
            {pulse && pulseTone_ && (
              <motion.span
                key={pulse.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: EASE }}
                className={cn(
                  'text-[13px] font-bold tabular-nums',
                  TONE[pulseTone_].text,
                )}
              >
                {pulse.direction === 'up' ? '+' : '−'}
                {formatNumber(Math.abs(pulse.delta))}
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-2 min-h-[20px]">
          {change !== undefined ? (
            <Trend change={change} label={changeLabel} sentiment={sentiment} />
          ) : hint ? (
            <span className="truncate text-[12px] text-ink-muted">{hint}</span>
          ) : null}
        </div>

        {hint && change !== undefined && (
          <p className="mt-0.5 truncate text-[12px] text-ink-faint">{hint}</p>
        )}

        {footer && <div className="mt-3">{footer}</div>}
      </div>

      {spark && spark.length > 1 && (
        <div className="-mt-1 opacity-90">
          <Sparkline data={spark} color={sparkColor} />
        </div>
      )}
    </Panel>
  );
}

/**
 * One figure in the secondary stat strip.
 *
 * The dashboard has more numbers than deserve a hero card. Nine equal cards read
 * as a wall of numbers with no first thing to look at — and at four to a row,
 * nine of them leave a lone card stranded on the last line. These are the quiet
 * five: same data, a third of the height, no shadow of their own because the
 * strip they sit in is the panel.
 */
export function StatTile({
  label,
  value,
  icon,
  hint,
  tooltip,
  tone = 'neutral',
  loading = false,
  sentiment,
  onClick,
}: {
  label: string;
  value: number | null;
  icon?: React.ReactNode;
  hint?: string;
  tooltip?: string;
  tone?: Tone;
  loading?: boolean;
  /** Which direction of change counts as good news. See [Trend]. */
  sentiment?: 'normal' | 'invert' | 'neutral';
  onClick?: () => void;
}) {
  const counted = useCountUp(loading ? null : value);
  const pulse = useChangePulse(loading ? null : value);
  const toneCls = TONE[tone];
  const pulseTone_ = pulse ? pulseTone(pulse.direction, sentiment) : null;

  return (
    <Panel
      interactive={!!onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      title={tooltip}
      className={cn('flex h-full min-w-0 items-center gap-3 px-4 py-3.5', onClick && 'cursor-pointer')}
    >
      {icon && (
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-[11px] [&>svg]:size-[17px]',
            toneCls.chip,
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-faint">
          {label}
        </p>
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-[22px] font-bold leading-tight tabular-nums tracking-tight text-ink">
            {loading ? (
              <Skeleton className="inline-block h-[15px] w-9 align-middle" />
            ) : counted === null ? (
              NO_VALUE
            ) : (
              formatNumber(counted)
            )}
          </span>
          <AnimatePresence>
            {pulse && pulseTone_ && (
              <motion.span
                key={pulse.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3, ease: EASE }}
                className={cn('shrink-0 text-[12px] font-bold tabular-nums', TONE[pulseTone_].text)}
              >
                {pulse.direction === 'up' ? '+' : '−'}
                {formatNumber(Math.abs(pulse.delta))}
              </motion.span>
            )}
          </AnimatePresence>
          {hint && <span className="min-w-0 truncate text-[12px] text-ink-muted">{hint}</span>}
        </div>
      </div>
    </Panel>
  );
}

/**
 * A metric's slice of a whole, as a bar under the headline.
 *
 * Sits in the hero cards' footer. The alternative was a sparkline in every
 * card, which the API cannot honestly supply: it returns one daily series for
 * the whole site, not one per category, so putting the same trace under
 * "Workers", "Staff" and "Visitors" would draw three identical lines and imply
 * three different measurements. A share of the current headcount is a number
 * this page actually holds.
 */
export function ShareBar({
  value,
  total,
  label,
  color,
}: {
  value: number | null;
  total: number | null;
  label: string;
  color: string;
}) {
  const reduced = useReducedMotion();
  const pct = value !== null && total ? Math.min(100, (value / total) * 100) : null;

  return (
    <div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        {pct !== null && (
          <motion.div
            className="h-full rounded-full"
            style={{ background: color }}
            initial={reduced ? false : { width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.15 }}
          />
        )}
      </div>
      <p className="mt-1.5 truncate text-[12px] text-ink-muted">
        {/* With no figure there is no percentage, and printing the bare tail
            left "of everyone on site" sitting under an empty track reading as
            an unfinished sentence. Say what is actually known instead. */}
        {pct === null ? 'Nobody on site in this category' : `${Math.round(pct)}% ${label}`}
      </p>
    </div>
  );
}


/**
 * A headline broken into the parts it is made of.
 *
 * Built for the case where one figure quietly means two things — "on site" being
 * both people who arrived today and sessions nobody ever closed. Showing the
 * split inside the card is what stops two screens disagreeing.
 */
export function SplitBar({
  parts,
}: {
  parts: { key: string; label: string; value: number; color: string; onClick?: () => void }[];
}) {
  const reduced = useReducedMotion();
  const total = parts.reduce((a, p) => a + (Number.isFinite(p.value) ? p.value : 0), 0);

  return (
    <div>
      <div className="mb-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-surface-sunken">
        {parts.map((p, i) => (
          <motion.span
            key={p.key}
            className="rounded-full"
            style={{ background: p.color }}
            initial={reduced ? false : { width: 0 }}
            animate={{ width: total > 0 ? `${(p.value / total) * 100}%` : 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: 0.1 + i * 0.06 }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {parts.map((p) => {
          const clickable = p.onClick && p.value > 0;
          return (
            <span
              key={p.key}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={
                clickable
                  ? (e) => {
                      e.stopPropagation();
                      p.onClick?.();
                    }
                  : undefined
              }
              onKeyDown={
                clickable
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        p.onClick?.();
                      }
                    }
                  : undefined
              }
              className={cn(
                'inline-flex items-center gap-1.5 text-[12px]',
                clickable && 'cursor-pointer hover:underline',
              )}
            >
              <span className="size-[7px] shrink-0 rounded-full" style={{ background: p.color }} />
              <b className="tabular-nums text-ink">{p.value}</b>
              <span className="text-ink-muted">{p.label}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** One line in the activity feed, with a rail connecting it to the next. */
export function ActivityRow({
  actor,
  description,
  detail,
  at,
  tone = 'neutral',
  last = false,
}: {
  actor: string;
  description: string;
  detail?: string | null;
  at: string;
  tone?: Tone;
  last?: boolean;
}) {
  const initials =
    actor
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';

  return (
    <div className="relative flex gap-3 px-5 py-2">
      {!last && <span className="absolute left-[31px] top-[38px] bottom-[-6px] w-px bg-line" />}
      <span
        className={cn(
          'z-[1] grid size-[30px] shrink-0 place-items-center rounded-full text-[12px] font-bold',
          TONE[tone].chip,
        )}
      >
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug">
          <b className="font-semibold text-ink">{actor}</b>{' '}
          <span className="text-ink-muted">{description}</span>
          {detail && (
            <>
              <span className="text-ink-muted"> — </span>
              <span className="text-ink-muted" title={detail}>
                {detail.length > 34 ? `${detail.slice(0, 33)}…` : detail}
              </span>
            </>
          )}
        </p>
        <p className="text-[12px] text-ink-faint">{formatRelative(at)}</p>
      </div>
    </div>
  );
}

/**
 * One operational exception, clickable through to the record that fixes it.
 *
 * Calm on purpose: this panel is a to-do list, and a dashboard where every open
 * item shouts is one nobody reads. Colour lives in a small dot and the count.
 */
export function ExceptionRow({
  label,
  description,
  count,
  tone = 'warning',
  onClick,
}: {
  label: string;
  description: string;
  count: number | null;
  tone?: Tone;
  onClick?: () => void;
}) {
  const clickable = !!onClick && !!count;
  const dot = {
    brand: 'bg-brand',
    positive: 'bg-positive',
    warning: 'bg-warning',
    critical: 'bg-critical',
    info: 'bg-info',
    neutral: 'bg-line',
  }[tone];

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={cn(
        'flex items-center gap-3 px-5 py-3 transition-colors',
        clickable && 'cursor-pointer hover:bg-surface-hover',
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', count ? dot : 'bg-line')} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">{label}</p>
        <p className="truncate text-[12px] text-ink-muted">{description}</p>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-md border px-2 py-0.5 text-[12px] font-bold tabular-nums',
          count ? TONE[tone].chip : 'border-line bg-surface-sunken text-ink-faint',
          count ? 'border-transparent' : '',
        )}
      >
        {count ?? '–'}
      </span>
      {clickable && (
        <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="m6 4 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}
