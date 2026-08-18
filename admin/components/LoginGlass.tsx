'use client';

import * as React from 'react';
import Image from 'next/image';
import Script from 'next/script';

declare global {
  interface Window {
    liquidGlass?: (
      el: Element,
      opts?: Record<string, unknown>,
    ) => { supported: boolean; refresh: () => void; destroy: () => void };
  }
}

/**
 * The sign-in page's backdrop and glass panel.
 *
 * The card is real refraction, not a blur: `liquid-glass.js` builds an SVG
 * displacement map from the card's own size and feeds it to `backdrop-filter`,
 * so the lobby behind it bends at the edges the way thick glass does. Only
 * Chromium can apply an SVG filter through a backdrop — Safari and Firefox
 * silently ignore it — so the library reports back and we keep a frosted blur
 * for them. Both look deliberate; only one looks like glass.
 *
 * The background goes through next/image rather than a CSS `background-image`
 * because the source render is a 2 MB PNG. Next re-encodes it to WebP/AVIF at
 * the size actually needed, which is the difference between a sign-in page that
 * appears instantly and one that does not.
 */
export function LoginGlass({ children }: { children: React.ReactNode }) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const glassRef = React.useRef<ReturnType<NonNullable<Window['liquidGlass']>> | null>(null);
  const [refracting, setRefracting] = React.useState(false);

  const attach = React.useCallback(() => {
    if (!cardRef.current || !window.liquidGlass || glassRef.current) return;
    const g = window.liquidGlass(cardRef.current, {
      // Transparency comes from the low blur and the near-absent tint, not from
      // the displacement. Pushing `scale` past about -70 drags the chromatic
      // fringing well outside the card and reads as a rendering fault rather
      // than as glass, so the bend stays modest: enough to curl the lobby at
      // the rim, while the middle of the card stays plainly readable.
      scale: -55,
      radius: 28,
      border: 0.07,
      blur: 2,
      saturate: 1.4,
    });
    glassRef.current = g;
    setRefracting(g.supported);
  }, []);

  React.useEffect(() => {
    // The script may already be cached from a previous visit, in which case the
    // onReady callback never fires.
    attach();
    return () => {
      glassRef.current?.destroy();
      glassRef.current = null;
    };
  }, [attach]);

  return (
    <div className="relative min-h-screen w-full overflow-hidden">
      <Script
        src="/vendor/liquid-glass/liquid-glass.js"
        strategy="afterInteractive"
        onReady={attach}
      />

      {/* Backdrop */}
      <Image
        src="/login-bg.png"
        alt=""
        fill
        priority
        sizes="100vw"
        className="object-cover"
      />
      {/* A light wash only. The previous one ran to 78% black at the edges,
          which flattened the photograph and left the card looking like a tinted
          panel on a dark background rather than glass over a room. The lobby
          render is already dim; it does not need help. */}
      <div className="absolute inset-0 bg-[radial-gradient(130%_100%_at_50%_45%,rgba(6,12,18,0.06),rgba(6,12,18,0.42))]" />

      {/* A pool of shade under the card, and nowhere else.
          The form is white-on-glass whatever the operator's colour mode, so it
          needs something dark beneath it — and the backdrop is a brand image
          whose brightest region, windows and daylight, is dead centre where the
          card sits. Dimming the whole picture to fix that would flatten the
          artwork; this dims only the disc the card covers and fades out well
          before the copy on the left or the logo wall on the right. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[820px] w-[960px] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(closest-side,rgba(4,10,16,0.66),rgba(4,10,16,0.34)_58%,rgba(4,10,16,0))]"
      />

      <div className="relative flex min-h-screen items-center justify-center p-5">
        <div
          ref={cardRef}
          className={[
            'relative w-full max-w-[420px] overflow-hidden rounded-[28px]',
            'border border-white/[0.22]',
            // Barely any tint when refraction is doing the work — the glass
            // should carry the effect, not a white film over it. The fallback
            // needs a little more, since a plain blur with no tint reads as a
            // smudge rather than a surface.
            refracting
              ? 'bg-white/[0.035]'
              : 'bg-white/[0.09] backdrop-blur-xl backdrop-saturate-150',
            'shadow-[0_30px_70px_-22px_rgba(0,0,0,0.7)]',
          ].join(' ')}
        >
          {/* Inner highlight — the bright top edge and soft floor that make a
              flat panel read as a solid piece of glass rather than a tinted box. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[28px]"
            style={{
              boxShadow:
                'inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(255,255,255,0.12), inset 0 0 26px rgba(255,255,255,0.05)',
            }}
          />
          {/* A single diagonal glare, low opacity. More than one and it stops
              looking like light and starts looking like a texture. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-px rounded-[28px] opacity-70"
            style={{
              background:
                'linear-gradient(115deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 32%, rgba(255,255,255,0) 68%, rgba(255,255,255,0.07) 100%)',
            }}
          />

          <div data-login-glass className="relative p-7">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
