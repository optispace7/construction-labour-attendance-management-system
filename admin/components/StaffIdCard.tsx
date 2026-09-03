'use client';

import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Organization, Worker } from '@/lib/types';
import { qrPayload } from '@/components/QrBadge';
import { photoSrc } from '@/components/PeopleDirectory';
import { CardSpec, cardMetrics } from '@/components/IdCard';

/**
 * Staff ID card — the company's own employees, printed to the brand artwork the
 * client already uses for its corporate cards: portrait, circular portrait on a
 * gradient ring, orange/navy sweeping bands on the reverse.
 *
 * Deliberately a different card from the worker/visitor one in IdCard.tsx. A
 * worker card carries site, induction, training seals and validity because a
 * gate officer reads those off it; a staff card carries the person, how to
 * reach them and where to return the card. The one thing the artwork has no
 * place for and we still need is the attendance QR, so it takes the empty
 * top-right corner of the reverse that the bands never reach.
 *
 * Everything is laid out in millimetres off the printed face, so the same card
 * renders correctly at every A4 scale and on every PVC stock.
 */

const ORANGE = '#FFA14A';
const NAVY = '#2E3D6B';
const INK = '#10375E'; // value text
const LABEL = '#919191'; // small-caps labels
const FINEPRINT = '#9A9A9A';
const PATTERN_BG = '#CBCBCB';
const PATTERN_FG = '#D9D9D9';
const WATERMARK = '#F2F2F2';

/** Bebas Neue for the small-caps labels, Comfortaa for names and values. */
const DISPLAY = 'var(--font-bebas), Oswald, "Arial Narrow", Impact, sans-serif';
const BODY = 'var(--font-comfortaa), Quicksand, "Century Gothic", system-ui, sans-serif';

const MM_PER_PX = 25.4 / 96;
const px = (mm: number) => Math.max(8, Math.round(mm / MM_PER_PX));

// Luminance either side of which a pixel is certainly the backdrop or
// certainly the person; in between it becomes the soft edge of the cut.
const BG_HI = 0.9;
const BG_LO = 0.72;

/**
 * Knock a plain white studio backdrop out of a portrait so the person sits on
 * the card's grey pattern instead of on a white rectangle.
 *
 * Flooded from the top and side edges only. A headshot's shoulders run off the
 * bottom of the frame and a white collar is the same colour as the backdrop, so
 * seeding from the bottom edge would eat the shirt; nothing above or beside the
 * head is ever the subject. Pixels in the threshold band fade out rather than
 * cutting off, which keeps the hairline from turning into a staircase.
 *
 * Returns null — leaving the photo untouched — unless the border really is
 * white, so the older snapshots taken against a site wall are never half
 * erased.
 */
function cutWhiteBackdrop(img: HTMLImageElement): string | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  let image: ImageData;
  try {
    image = ctx.getImageData(0, 0, w, h);
  } catch {
    return null; // cross-origin photo: the canvas is tainted
  }
  const p = image.data;
  const lum = (i: number) => (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) / 255;

  let border = 0;
  let white = 0;
  for (let x = 0; x < w; x++) {
    border++;
    if (lum(x * 4) >= BG_HI) white++;
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      border++;
      if (lum((y * w + x) * 4) >= BG_HI) white++;
    }
  }
  if (white / border < 0.7) return null;

  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (idx: number) => {
    if (seen[idx] || lum(idx * 4) < BG_LO) return;
    seen[idx] = 1;
    queue[tail++] = idx;
  };
  for (let x = 0; x < w; x++) push(x);
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x > 0) push(idx - 1);
    if (x < w - 1) push(idx + 1);
    if (y > 0) push(idx - w);
    if (y < h - 1) push(idx + w);
  }

  for (let idx = 0; idx < w * h; idx++) {
    if (!seen[idx]) continue;
    const a = (BG_HI - lum(idx * 4)) / (BG_HI - BG_LO);
    p[idx * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, a)));
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** The cut-out portrait once the browser has produced it, else undefined. */
function useCutOutPortrait(src?: string): string | undefined {
  const [cut, setCut] = React.useState<string>();
  React.useEffect(() => {
    setCut(undefined);
    if (!src) return;
    let live = true;
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!live) return;
      try {
        const out = cutWhiteBackdrop(img);
        if (out) setCut(out);
      } catch {
        // Any failure just leaves the original photo on the card.
      }
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return cut;
}

/** Trailing "Bengaluru Karnataka 560008"-style line built from the org profile. */
function cityLine(org?: Organization | null): string {
  return [org?.city, org?.state, org?.pincode].filter(Boolean).join(' ');
}

export function StaffIdCard({
  worker,
  org,
  spec,
  side,
}: {
  worker: Worker;
  org?: Organization | null;
  spec: CardSpec;
  side: 'front' | 'back';
}) {
  const { w, h } = cardMetrics(spec);
  const X = (f: number) => f * w;
  const Y = (f: number) => f * h;

  const face: React.CSSProperties = {
    width: `${w}mm`,
    height: `${h}mm`,
    boxSizing: 'border-box',
    position: 'relative',
    overflow: 'hidden',
    background: '#fff',
    color: INK,
    fontFamily: BODY,
    breakInside: 'avoid',
    printColorAdjust: 'exact',
    WebkitPrintColorAdjust: 'exact',
    // A4 sheets are cut apart by hand, so the face needs a visible trim line.
    // PVC stock is already the right shape — a border there prints as a rim.
    border: spec.mode === 'A4' ? '0.2mm solid #d9d9d9' : undefined,
  };

  const artLayer: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  };

  // Gradient/clip/filter ids are per face, so two cards on one sheet never collide.
  const gid = `${side}-${worker.id}`;

  // Hooks run before the front/back branch below. Only the front carries a
  // portrait, so the back never asks the browser to cut one.
  const rawPhoto = worker.photoUrl ? photoSrc(worker.photoUrl) : undefined;
  const cutPhoto = useCutOutPortrait(side === 'front' ? rawPhoto : undefined);

  if (side === 'front') {
    // The portrait sits in a circle whose left edge runs off the card, with a
    // thick gradient ring around it — the ring's top-left runs off too.
    const cx = X(0.365);
    const cy = Y(0.128);
    const rInner = X(0.48);
    const band = X(0.135);
    const rMid = rInner + band / 2;

    // Photo box, bottom-clipped by the circle, matching the reference crop.
    const pX = X(0.075);
    const pY = Y(0.05);
    const pW = X(0.47);
    const pH = Y(0.44);

    const name = (worker.fullName ?? '').trim();
    const nameMm = name.length <= 14 ? Y(0.066) : name.length <= 22 ? Y(0.055) : Y(0.045);
    // The app already ships the client's mark for the shell and the login
    // page; the card uses the vector copy so it stays sharp at ~9 mm wide. An
    // organization that uploads its own logo on the Company page still wins.
    const logo = org?.logoUrl ? photoSrc(org.logoUrl) : '/logo.svg';

    return (
      <div style={face} className="clams-card-face">
        <svg style={artLayer} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient
              id={`ring-${gid}`}
              gradientUnits="userSpaceOnUse"
              x1={w}
              y1={Y(0.02)}
              x2={0}
              y2={Y(0.52)}
            >
              <stop offset="0" stopColor={ORANGE} />
              <stop offset="0.45" stopColor="#B98259" />
              <stop offset="1" stopColor={NAVY} />
            </linearGradient>
            <clipPath id={`photo-${gid}`}>
              <circle cx={cx} cy={cy} r={rInner} />
            </clipPath>
            {/* The reference card prints its portrait in black and white, and
                it also levels out phone photos shot under different site
                lighting, so every card looks like it came off one press. */}
            <filter id={`grey-${gid}`} colorInterpolationFilters="sRGB">
              <feColorMatrix type="saturate" values="0" />
            </filter>
          </defs>

          {/* Faint sweep behind the lower half, echoing the reverse artwork. */}
          <path
            d={`M ${X(-0.1)} ${Y(0.95)} C ${X(0.15)} ${Y(0.72)}, ${X(0.75)} ${Y(0.66)}, ${X(1.15)} ${Y(0.78)}`}
            fill="none"
            stroke={WATERMARK}
            strokeWidth={X(0.17)}
          />

          {/* Patterned backdrop and portrait, both clipped to the circle. */}
          <g clipPath={`url(#photo-${gid})`}>
            <circle cx={cx} cy={cy} r={rInner} fill={PATTERN_BG} />
            <g fill={PATTERN_FG}>
              <circle cx={cx - rInner * 0.62} cy={cy - rInner * 0.5} r={rInner * 0.17} />
              <rect
                x={cx - rInner * 0.2}
                y={cy - rInner * 0.85}
                width={rInner * 0.3}
                height={rInner * 0.3}
              />
              <path
                d={`M ${cx + rInner * 0.2} ${cy - rInner * 0.75} a ${rInner * 0.2} ${rInner * 0.2} 0 0 1 ${rInner * 0.4} 0 z`}
              />
              <circle
                cx={cx + rInner * 0.55}
                cy={cy - rInner * 0.3}
                r={rInner * 0.19}
                fill="none"
                stroke={PATTERN_FG}
                strokeWidth={rInner * 0.07}
              />
              <rect
                x={cx - rInner * 0.9}
                y={cy + rInner * 0.05}
                width={rInner * 0.34}
                height={rInner * 0.34}
                rx={rInner * 0.08}
              />
              <path
                d={`M ${cx + rInner * 0.3} ${cy + rInner * 0.45} h ${rInner * 0.36} v ${rInner * 0.36} z`}
              />
              <circle cx={cx - rInner * 0.35} cy={cy + rInner * 0.7} r={rInner * 0.12} />
            </g>
            {rawPhoto ? (
              <image
                href={cutPhoto ?? rawPhoto}
                x={pX}
                y={pY}
                width={pW}
                height={pH}
                preserveAspectRatio="xMidYMid slice"
                filter={`url(#grey-${gid})`}
              />
            ) : null}
          </g>

          {/* The gradient ring itself. */}
          <circle
            cx={cx}
            cy={cy}
            r={rMid}
            fill="none"
            stroke={`url(#ring-${gid})`}
            strokeWidth={band}
          />
        </svg>

        {/* Name — bottom-aligned, so a two-line name grows up into the gap. */}
        <div
          style={{
            position: 'absolute',
            left: `${X(0.085)}mm`,
            right: `${X(0.13)}mm`,
            top: `${Y(0.55)}mm`,
            height: `${Y(0.2)}mm`,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            fontFamily: BODY,
            fontWeight: 700,
            color: ORANGE,
            fontSize: `${nameMm}mm`,
            lineHeight: 1.12,
            textTransform: 'uppercase',
            overflow: 'hidden',
            wordBreak: 'break-word',
          }}
        >
          {name}
        </div>

        <div
          style={{
            position: 'absolute',
            left: `${X(0.085)}mm`,
            right: `${X(0.13)}mm`,
            top: `${Y(0.765)}mm`,
            height: `${Math.max(0.25, X(0.006))}mm`,
            background: ORANGE,
          }}
        />

        {/* Employee ID on the left, company logo on the right. */}
        <div
          style={{
            position: 'absolute',
            left: `${X(0.085)}mm`,
            right: `${X(0.08)}mm`,
            top: `${Y(0.795)}mm`,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: `${X(0.04)}mm`,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: DISPLAY,
                color: LABEL,
                fontSize: `${Y(0.026)}mm`,
                letterSpacing: `${Y(0.0035)}mm`,
                lineHeight: 1.1,
              }}
            >
              EMPLOYEE ID
            </div>
            <div
              style={{
                fontFamily: BODY,
                fontWeight: 600,
                color: INK,
                fontSize: `${Y(0.036)}mm`,
                lineHeight: 1.25,
                whiteSpace: 'nowrap',
              }}
            >
              {worker.workerCode}
            </div>
          </div>
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt=""
              style={{
                maxHeight: `${Y(0.085) * (org?.logoScale ?? 1)}mm`,
                maxWidth: `${X(0.4)}mm`,
                objectFit: 'contain',
                display: 'block',
              }}
            />
          ) : null}
        </div>

        {org?.website ? (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: `${Y(0.022)}mm`,
              textAlign: 'center',
              fontFamily: BODY,
              color: INK,
              fontSize: `${Y(0.026)}mm`,
              lineHeight: 1.1,
            }}
          >
            {org.website}
          </div>
        ) : null}
      </div>
    );
  }

  // ---- Reverse: sweeping bands, contact details, QR, return-to address ----
  const qrMm = X(0.25);
  const iconMm = Y(0.022);
  const rows: { icon: React.ReactNode; label: string; value: string; mm?: number }[] = [];
  if (worker.email)
    rows.push({
      icon: <MailIcon mm={iconMm} />,
      label: 'MAIL ID',
      // A long address wrapping to a second line pushes the blood group down
      // into the fine print, so it shrinks to one line instead. 0.6em is about
      // Comfortaa's average advance, which is close enough to keep the longest
      // work address on the line without measuring it in the browser.
      mm: Math.min(Y(0.031), X(0.62) / (worker.email.length * 0.6)),
      value: worker.email,
    });
  const emergency = worker.emergencyContactNumber || worker.mobileNumber || '';
  if (emergency)
    rows.push({ icon: <PhoneIcon mm={iconMm} />, label: 'EMERGENCY CONTACT', value: emergency });
  if (worker.bloodGroup)
    rows.push({ icon: <DropIcon mm={iconMm} />, label: 'BLOOD GROUP', value: worker.bloodGroup });

  const returnTo = ['IF FOUND PLEASE DELIVER TO', org?.name, org?.addressLine1, cityLine(org)]
    .filter(Boolean)
    .join(' ');

  return (
    <div style={face} className="clams-card-face">
      <svg style={artLayer} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
        <defs>
          {/* Navy at the top of the sweep, warming to orange as it comes down
              the left edge — the transition sits in the top third, as on the
              reference card. */}
          <linearGradient
            id={`band-${gid}`}
            gradientUnits="userSpaceOnUse"
            x1={0}
            y1={Y(0.02)}
            x2={0}
            y2={Y(0.44)}
          >
            <stop offset="0" stopColor={NAVY} />
            <stop offset="0.55" stopColor="#8A6A6B" />
            <stop offset="1" stopColor={ORANGE} />
          </linearGradient>
        </defs>

        {/* The reverse carries two bands, traced off the reference card's own
            profile rather than eyeballed: measured across its 54 mm face, one
            band hugs the left edge alone below y=0.3 (right edge 0.13w at the
            waist, flaring to 0.21w at the foot), and the second exists only
            across the top, entering the left edge and leaving the right one.
            Two full-height bands — the first attempt — ate a third of the
            card's width and left the fine print sitting on the artwork.

            The one deliberate departure: the reference's tip reaches 0.67w,
            which is exactly where the attendance QR has to live. Ours stops at
            0.52w so the QR clears it. */}

        {/* Pale echo, just outside the left band. */}
        <path
          d={`M ${X(0.3)} ${Y(1.1)} C ${X(0.19)} ${Y(0.84)}, ${X(0.2)} ${Y(0.56)}, ${X(0.27)} ${Y(0.36)} C ${X(0.33)} ${Y(0.25)}, ${X(0.42)} ${Y(0.22)}, ${X(0.48)} ${Y(0.225)}`}
          fill="none"
          stroke={WATERMARK}
          strokeWidth={X(0.1)}
          strokeLinecap="round"
        />

        {/* Top band: in at the left edge, over the shoulder, out at the right. */}
        <path
          d={`M ${X(-0.05)} ${Y(0.235)} C ${X(0.15)} ${Y(0.115)}, ${X(0.35)} ${Y(0.045)}, ${X(0.62)} ${Y(0.04)} C ${X(0.82)} ${Y(0.04)}, ${X(0.96)} ${Y(0.07)}, ${X(1.06)} ${Y(0.095)}`}
          fill="none"
          stroke={`url(#band-${gid})`}
          strokeWidth={X(0.119)}
        />

        {/* Left band: up the edge from the foot, then curling right to a tip.
            Wider than it looks and set so its left side runs off the card —
            centred on the visible width instead, it left a white sliver down
            the edge that the reference does not have. */}
        <path
          d={`M ${X(0.13)} ${Y(1.1)} C ${X(0.025)} ${Y(0.86)}, ${X(0.03)} ${Y(0.58)}, ${X(0.1)} ${Y(0.38)} C ${X(0.17)} ${Y(0.25)}, ${X(0.31)} ${Y(0.205)}, ${X(0.43)} ${Y(0.215)}`}
          fill="none"
          stroke={`url(#band-${gid})`}
          strokeWidth={X(0.15)}
          strokeLinecap="round"
        />

        {/* The band swings out towards the foot rather than thickening, and one
            constant-width stroke cannot do that and still end in a slim tip, so
            a filled wedge carries it into the bottom-left corner. Its right
            edge stays inside the stroke's until the last millimetre, so the two
            meet without a step — same gradient in the same user space, so there
            is no seam either. It has to reach the corner: a CR80 blank is cut
            with a ~3 mm radius, and artwork stopping short of the corner leaves
            the rounded cut showing white. */}
        <path
          d={`M 0 ${Y(0.8)} L ${X(0.06)} ${Y(0.8)} C ${X(0.1)} ${Y(0.9)}, ${X(0.13)} ${Y(0.95)}, ${X(0.19)} ${Y(1.02)} L 0 ${Y(1.02)} Z`}
          fill={`url(#band-${gid})`}
        />

      </svg>

      {/* Attendance QR — the one addition to the artwork. It sits below the top
          sweep and to the right of the inner band's tip, which is the only
          block of the reverse the artwork leaves clear. Same CLAMS:<code>
          payload the gate tablet already reads off a worker card. */}
      <div
        style={{
          position: 'absolute',
          right: `${X(0.06)}mm`,
          // Clear of the top band, which measures down to 0.105h across the
          // QR's columns and 0.121h at the right edge.
          top: `${Y(0.135)}mm`,
          textAlign: 'center',
        }}
      >
        <div style={{ lineHeight: 0 }}>
          <QRCodeSVG value={qrPayload(worker.workerCode)} size={px(qrMm)} includeMargin={false} />
        </div>
        <div
          style={{
            fontFamily: DISPLAY,
            color: LABEL,
            fontSize: `${Y(0.02)}mm`,
            letterSpacing: `${Y(0.003)}mm`,
            marginTop: `${Y(0.006)}mm`,
            lineHeight: 1.1,
          }}
        >
          SCAN AT SITE
        </div>
      </div>

      {/* Contact rows, centred in the clear right-hand column. */}
      <div
        style={{
          position: 'absolute',
          left: `${X(0.32)}mm`,
          right: `${X(0.06)}mm`,
          top: `${Y(0.365)}mm`,
          display: 'flex',
          flexDirection: 'column',
          gap: `${Y(0.028)}mm`,
          textAlign: 'center',
        }}
      >
        {rows.map((r) => (
          <div key={r.label}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: `${X(0.02)}mm`,
                fontFamily: DISPLAY,
                color: LABEL,
                fontSize: `${Y(0.024)}mm`,
                letterSpacing: `${Y(0.003)}mm`,
                lineHeight: 1.1,
              }}
            >
              {r.icon}
              {r.label}
            </div>
            <div
              style={{
                fontFamily: BODY,
                color: INK,
                fontSize: `${r.mm ?? Y(0.031)}mm`,
                lineHeight: 1.3,
                marginTop: `${Y(0.006)}mm`,
                wordBreak: 'break-word',
              }}
            >
              {r.value}
            </div>
          </div>
        ))}
      </div>

      {/* Fine print, right-aligned above the bottom edge. */}
      <div
        style={{
          position: 'absolute',
          left: `${X(0.26)}mm`,
          right: `${X(0.06)}mm`,
          bottom: `${Y(0.035)}mm`,
          textAlign: 'right',
          fontFamily: DISPLAY,
          color: FINEPRINT,
          fontSize: `${Y(0.02)}mm`,
          letterSpacing: `${Y(0.002)}mm`,
          lineHeight: 1.35,
          display: 'flex',
          flexDirection: 'column',
          gap: `${Y(0.022)}mm`,
        }}
      >
        <div>
          THE ID CARD IS STRICTLY FOR OFFICIAL USE &amp; SHOULD NOT BE SHARED OR USED FOR
          UNAUTHORIZED PURPOSES
        </div>
        {org?.name ? <div>{returnTo}</div> : null}
        {org?.addressLine2 ? <div>{org.addressLine2}</div> : null}
      </div>
    </div>
  );
}

// ---- Tiny inline icons, sized in mm so they track the label text ----

function MailIcon({ mm }: { mm: number }) {
  return (
    <svg
      width={`${mm * 1.25}mm`}
      height={`${mm}mm`}
      viewBox="0 0 20 16"
      fill="none"
      stroke={LABEL}
      strokeWidth={1.6}
      aria-hidden
    >
      <rect x="1" y="1" width="18" height="14" />
      <path d="M1 2l9 7 9-7" />
    </svg>
  );
}

function PhoneIcon({ mm }: { mm: number }) {
  return (
    <svg width={`${mm}mm`} height={`${mm}mm`} viewBox="0 0 16 16" fill={LABEL} aria-hidden>
      <path d="M4.3 1.2 6 4.4 4.4 6a10 10 0 0 0 5.6 5.6L11.6 10l3.2 1.7-.6 3A1.4 1.4 0 0 1 12.6 16 12.6 12.6 0 0 1 0 3.4 1.4 1.4 0 0 1 1.3 1.8Z" />
    </svg>
  );
}

function DropIcon({ mm }: { mm: number }) {
  return (
    <svg
      width={`${mm}mm`}
      height={`${mm}mm`}
      viewBox="0 0 16 16"
      fill="none"
      stroke={LABEL}
      strokeWidth={1.3}
      aria-hidden
    >
      <path d="M8 1.5 3.8 6.6a5.4 5.4 0 1 0 8.4 0Z" />
    </svg>
  );
}
