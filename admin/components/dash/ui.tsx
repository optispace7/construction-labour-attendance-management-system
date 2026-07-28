'use client';

import * as React from 'react';
import { motion, useReducedMotion, type Variants } from 'framer-motion';
import { cn } from '@/lib/cn';

/**
 * The Tailwind building blocks for the workforce dashboard.
 *
 * Deliberately not MUI. The dashboard needed real chart rendering and real
 * motion, and `@mui/x-charts` gives thin control over both, so this page is
 * built on Tailwind + Recharts + framer-motion instead. Everything still reads
 * the same `--clams-*` tokens as the rest of the panel, so the two systems
 * cannot drift apart on colour, and the theme toggle drives both at once.
 */

/** Shared easing. Fast out of the gate, settles gently — never bouncy. */
export const EASE = [0.22, 1, 0.36, 1] as const;

export const containerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.04 } },
};

export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } },
};

/**
 * A section that fades its children in one after another as it mounts.
 *
 * `once` is the point: a dashboard that re-animates every time a poll returns
 * is exhausting on a wall display, so the entrance plays a single time.
 */
export function Stagger({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      variants={containerVariants}
      initial={reduced ? false : 'hidden'}
      animate="show"
    >
      {children}
    </motion.div>
  );
}

export function Item({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div variants={itemVariants} className={className}>
      {children}
    </motion.div>
  );
}

/** The standard panel: surface, hairline, soft shadow, lifts slightly on hover. */
export function Panel({
  children,
  className,
  interactive = false,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        'relative rounded-panel border border-line bg-surface shadow-card',
        'transition-[border-color,box-shadow,transform] duration-200 ease-out',
        // A one-pixel highlight along the top edge, brightest in the middle.
        // It is what makes a dark card read as a lit surface rather than a
        // rectangle of slightly different grey; inset from the corners so it
        // never runs past the radius. Invisible on the light theme, which
        // carries its edges with shadow instead.
        'after:pointer-events-none after:absolute after:inset-x-6 after:top-0 after:h-px',
        'after:bg-gradient-to-r after:from-transparent after:via-white/10 after:to-transparent',
        // A 2px nudge was too polite to read as a response at all. This lifts
        // the card properly, brightens its edge and drops a real shadow — the
        // card should look picked up, not merely nudged.
        // Reaches for the elevated token rather than a literal, so the lift
        // stays one step above the resting shadow in both colour modes.
        interactive &&
          'hover:-translate-y-1 hover:scale-[1.015] hover:border-brand/40 hover:shadow-elevated',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Panel header: title, optional subtitle, optional right-hand control. */
export function PanelHead({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          {title}
        </h3>
        {subtitle && (
          <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Uppercase band label that introduces a group of panels.
 *
 * The rule running from the label to the right edge is doing real work. Five
 * sections of cards on one page, each announced by a small grey word floating
 * over a grid, gives the eye nothing to hang the structure on — the page reads
 * as one long scroll of panels. A rule turns each label into a masthead and the
 * page into chapters. It fades out rather than hitting the margin, so it frames
 * the title instead of boxing the section.
 */
export function SectionLabel({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3.5">
      <div className="flex items-center gap-3">
        <p className="shrink-0 text-[12px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
          {title}
        </p>
        <span
          aria-hidden
          className="h-px min-w-4 flex-1 bg-gradient-to-r from-line via-line to-transparent"
        />
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {description && <p className="mt-1.5 text-[13px] text-ink-muted">{description}</p>}
    </div>
  );
}

/** Shimmering placeholder. Sized by the caller to match what is coming. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={cn('relative overflow-hidden rounded-md bg-surface-sunken', className)}
      style={style}
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />
    </div>
  );
}

export type SkeletonShape = 'bars' | 'rows' | 'donut' | 'split' | 'block';

/**
 * A placeholder in the shape of the thing that is coming.
 *
 * A grey rectangle tells you only that something is loading. A row of bars of
 * uneven height tells you a chart is loading, and the panel does not jump when
 * the data lands because the placeholder already occupies the same silhouette.
 * The uneven heights are deliberate and fixed — a random shuffle on every
 * render reads as noise, and an even row reads as a progress bar.
 */
export function ChartSkeleton({
  height = 240,
  shape = 'bars',
}: {
  height?: number;
  shape?: SkeletonShape;
}) {
  if (shape === 'rows') {
    return (
      <div className="space-y-3 px-5 pb-5" style={{ height }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3" style={{ width: `${68 - i * 9}%` }} />
              <Skeleton className="h-2.5" style={{ width: `${44 - i * 6}%` }} />
            </div>
            <Skeleton className="h-5 w-9 shrink-0 rounded-md" />
          </div>
        ))}
      </div>
    );
  }

  if (shape === 'donut') {
    return (
      <div className="flex items-center gap-6 px-5 pb-5" style={{ height }}>
        <Skeleton className="aspect-square w-[42%] max-w-[170px] shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="size-2.5 shrink-0 rounded-sm" />
              <Skeleton className="h-3 flex-1" style={{ maxWidth: `${76 - i * 11}%` }} />
              <Skeleton className="h-3 w-8 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (shape === 'split') {
    return (
      <div className="px-5 pb-5" style={{ height }}>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-3 h-9 w-full rounded-lg" />
        <div className="mt-4 space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2.5">
              <Skeleton className="size-2.5 shrink-0 rounded-sm" />
              <Skeleton className="h-3 flex-1" style={{ maxWidth: `${70 - i * 12}%` }} />
              <Skeleton className="h-3 w-7 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (shape === 'block') {
    return (
      <div className="px-5 pb-5" style={{ height }}>
        <Skeleton className="h-full w-full rounded-card" />
      </div>
    );
  }

  // bars
  const heights = [52, 74, 41, 88, 63, 96, 57, 80, 46, 70, 90, 60];
  return (
    <div className="flex flex-col px-5 pb-5" style={{ height }}>
      <div className="flex min-h-0 flex-1 items-end gap-2">
        {heights.map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-t-md" style={{ height: `${h}%` }} />
        ))}
      </div>
      <Skeleton className="mt-3 h-2.5 w-full shrink-0" />
    </div>
  );
}

/**
 * Nothing to show. Kept calm on purpose — an empty state is not a failure, and
 * dressing it in warning colours teaches people to ignore the ones that matter.
 */
export function Empty({
  title = 'Nothing to show',
  description,
  icon,
  minHeight = 180,
}: {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  minHeight?: number;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 px-6 py-8 text-center"
      style={{ minHeight }}
    >
      <div className="grid size-10 place-items-center rounded-full border border-line bg-surface-sunken text-ink-faint">
        {icon ?? <InboxIcon />}
      </div>
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      {description && <p className="max-w-[280px] text-[12px] text-ink-muted">{description}</p>}
    </div>
  );
}

/** The request failed. Shows the server's own sentence when there is one. */
export function ErrorState({
  message,
  onRetry,
  minHeight = 180,
}: {
  message?: string;
  onRetry?: () => void;
  minHeight?: number;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 px-6 py-8 text-center"
      style={{ minHeight }}
    >
      <div className="grid size-10 place-items-center rounded-full bg-critical-subtle text-critical">
        <AlertIcon />
      </div>
      <p className="text-[13px] font-semibold text-ink">Could not load this</p>
      <p className="max-w-[300px] text-[12px] text-ink-muted">
        {message || 'The server did not answer. It may be a temporary problem.'}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-md border border-line px-2.5 py-1 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Panel + the four states it can be in.
 *
 * Handling loading, error, empty and has-data in one place is the whole point:
 * a panel that implements three of the four is the one that ships broken.
 * `error` deliberately beats `loading`, so a failed background refetch shows the
 * failure rather than spinning forever.
 */
export function ChartPanel({
  title,
  subtitle,
  action,
  footer,
  loading,
  error,
  empty,
  emptyTitle,
  emptyDescription,
  onRetry,
  bodyHeight = 240,
  skeleton = 'bars',
  className,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
  bodyHeight?: number;
  /** Which silhouette to hold while loading. Match it to the real content. */
  skeleton?: SkeletonShape;
  className?: string;
  children: React.ReactNode;
}) {
  let body: React.ReactNode;
  if (error) body = <ErrorState message={error} onRetry={onRetry} minHeight={bodyHeight} />;
  else if (loading) body = <ChartSkeleton height={bodyHeight} shape={skeleton} />;
  else if (empty)
    body = (
      <Empty
        title={emptyTitle ?? 'No data for this period'}
        description={emptyDescription}
        minHeight={bodyHeight}
      />
    );
  else body = <div className="min-w-0">{children}</div>;

  return (
    <Panel className={cn('flex h-full flex-col overflow-hidden', className)}>
      <PanelHead title={title} subtitle={subtitle} action={action} />
      <div className="min-w-0 flex-1">{body}</div>
      {footer && !loading && !error && (
        <div className="border-t border-line bg-surface-sunken px-5 py-2.5">{footer}</div>
      )}
    </Panel>
  );
}

/** Small pill used for statuses and counts. */
export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'brand' | 'positive' | 'warning' | 'critical' | 'info';
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-surface-sunken text-ink-muted border-line',
    brand: 'bg-brand-subtle text-brand border-brand/25',
    positive: 'bg-positive-subtle text-positive border-positive/25',
    warning: 'bg-warning-subtle text-warning border-warning/25',
    critical: 'bg-critical-subtle text-critical border-critical/25',
    info: 'bg-info-subtle text-info border-info/25',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] font-semibold tabular-nums',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="size-4">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} className="size-4">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" strokeLinecap="round" />
    </svg>
  );
}
