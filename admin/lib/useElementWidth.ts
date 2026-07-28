'use client';

import * as React from 'react';

/**
 * An element's own width in pixels, tracked as it changes.
 *
 * Panels in this app cannot lay themselves out from viewport breakpoints. A
 * card sits in a third of a column inside a main area whose width depends on
 * whether the nav rail is collapsed — so `2xl:` can be true while the card is
 * 430px wide and its contents are being crushed. Measuring the element is the
 * only honest answer.
 *
 * The half-pixel guard matters: the rail animates its width, and an unguarded
 * observer re-renders the whole chart on every frame of that animation.
 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = React.useRef<T | null>(null);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}
