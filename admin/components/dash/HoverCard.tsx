'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/cn';

/**
 * Every mounted hover panel's close function.
 *
 * Only one may be open at a time, anywhere on the page. `pointerleave` is not
 * guaranteed to arrive: scrolling moves content under a stationary pointer, so
 * a card can slide beneath the cursor, receive `pointerenter`, and never be told
 * the pointer left. Two overlapping lists of names was the visible result.
 * Opening one panel closes the rest, which makes that impossible regardless of
 * which events actually turn up.
 */
const openPanels = new Set<() => void>();

/**
 * A hover panel anchored to whatever it wraps.
 *
 * Deliberately not a tooltip: the content is a list of people, several lines
 * deep, and a tooltip that vanishes the moment the pointer drifts is no use for
 * reading names off. This stays open while the pointer is over either the
 * trigger or the panel, so you can move onto it and scroll.
 *
 * Flips to the left edge when the trigger sits near the right of the viewport,
 * so the last card in a row does not push the page sideways.
 */
export function HoverCard({
  children,
  content,
  disabled = false,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [alignRight, setAlignRight] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * This panel's close handle, created once and never replaced.
   *
   * It has to be stable: the registry identifies panels by function identity,
   * and a handle rebuilt on every render would never match the one stored, so
   * "close all the others" would close this one too — or nothing at all.
   */
  const close = React.useRef<() => void>();
  if (!close.current) {
    close.current = () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      setOpen(false);
    };
  }

  React.useEffect(() => {
    const self = close.current!;
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      openPanels.delete(self);
    };
  }, []);

  const show = () => {
    if (disabled) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    for (const other of openPanels) {
      if (other !== close.current) other();
    }
    openPanels.clear();
    openPanels.add(close.current!);

    const box = ref.current?.getBoundingClientRect();
    if (box) setAlignRight(box.left + 300 > window.innerWidth);
    setOpen(true);
  };

  // A short grace period so the pointer can cross the gap between the trigger
  // and the panel without the panel disappearing under it.
  const hide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      openPanels.delete(close.current!);
    }, 120);
  };

  return (
    <div
      ref={ref}
      // The wrapper itself has to lift while open, not just the panel. Each KPI
      // sits in its own grid item, so a panel with a high z-index inside an
      // un-lifted item still paints under every item that comes after it in the
      // DOM — which is why the list showed through the cards below it.
      className={cn('relative h-full', open ? 'z-50' : 'z-0')}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      <AnimatePresence>
        {open && !disabled && (
          <motion.div
            role="tooltip"
            className={cn(
              'absolute top-full mt-2 w-[290px] rounded-card border border-line bg-surface-elevated p-3 shadow-elevated',
              alignRight ? 'right-0' : 'left-0',
            )}
            // Slide only — opacity is deliberately NOT animated. A panel that
            // is mid-fade is a translucent one, and the card behind it reads
            // straight through the list of names. The background is opaque, so
            // it stays opaque; movement alone is enough of an entrance.
            initial={{ y: -6 }}
            animate={{ y: 0 }}
            exit={{ y: -6 }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
          >
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export interface StatPerson {
  fullName: string;
  workerCode: string;
  siteName: string | null;
  loginAt: string;
  workDate?: string;
  carriedOver?: boolean;
}

/**
 * The people behind a headcount.
 *
 * Caps at eight and says how many more there are — a hover panel listing forty
 * names is one nobody reads, and the full list lives on the Attendance page.
 * Anyone still open from an earlier day is marked, because that is usually the
 * explanation for a number looking higher than the site feels.
 */
export function PeopleList({
  title,
  people,
  total,
  emptyText = 'Nobody in this list right now.',
}: {
  title: string;
  people: StatPerson[] | undefined;
  total: number;
  emptyText?: string;
}) {
  const shown = (people ?? []).slice(0, 8);

  if (!people || total === 0) {
    return (
      <>
        <p className="mb-1 text-[12px] font-bold uppercase tracking-[0.07em] text-ink-faint">
          {title}
        </p>
        <p className="text-[12px] text-ink-muted">{emptyText}</p>
      </>
    );
  }

  return (
    <>
      <p className="mb-1.5 text-[12px] font-bold uppercase tracking-[0.07em] text-ink-faint">
        {title}
      </p>
      <ul className="space-y-1">
        {shown.map((p) => (
          <li key={`${p.workerCode}-${p.loginAt}`} className="text-[12px] leading-snug">
            <span className="font-semibold text-ink">{p.fullName}</span>{' '}
            <span className="text-ink-faint">({p.workerCode})</span>
            <span className="block text-ink-muted">
              {p.siteName ?? 'Unknown site'} ·{' '}
              {new Date(p.loginAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })}
              {p.carriedOver && (
                <span className="font-semibold text-warning">
                  {' '}
                  · since{' '}
                  {p.workDate
                    ? new Date(`${p.workDate}T00:00:00`).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                      })
                    : 'an earlier day'}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {total > shown.length && (
        <p className="mt-1.5 text-[12px] italic text-ink-faint">
          …and {total - shown.length} more
        </p>
      )}
    </>
  );
}
