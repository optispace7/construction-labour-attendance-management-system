/**
 * The daily manpower sheet, drawn as a picture.
 *
 * Deliberately painted onto a canvas by hand rather than screenshotting the DOM
 * with a library: this sheet also exists in the mobile app, and the two have to
 * come out looking like the same document. Explicit geometry is the only way to
 * keep them in step — an HTML-to-image pass would inherit whatever the admin
 * panel's theme happens to be doing that week, including its dark mode, which
 * would put white text on a white page.
 *
 * Every measurement below is in the same logical units as the Flutter sheet in
 * mobile/lib/features/supervisor/day_summary_image.dart. Change one, change both.
 */

export interface SheetLine {
  name: string;
  count: number;
}

export type SheetAudience = 'client' | 'internal';

export interface SheetOptions {
  audience: SheetAudience;
  companyName?: string | null;
  /** Already-loaded logo, or null. Loading is the caller's job — see loadLogo. */
  logo?: HTMLImageElement | null;
  logoScale?: number;
  siteName: string;
  dateLabel: string;
  byDesignation: SheetLine[];
  byVendor: SheetLine[];
}

// Palette, matching ClamsColors in the mobile theme.
const INK = '#1C2430';
const MUTED = '#5B6675';
const PRIMARY = '#3E5BA9';
const BORDER = '#E3E6EB';
const ZEBRA = '#F7F8FA';
const TOTAL_BG = '#EDF0F7';
const PAPER = '#FFFFFF';

const WIDTH = 640;
const PAD_X = 36;
const PAD_TOP = 32;
const PAD_BOTTOM = 28;

const LOGO_W = 96;
const LOGO_H = 48;

const TABLE_HEADER_H = 40;
const ROW_H = 42;
const TOTAL_H = 44;
const EMPTY_H = 44;
const TABLE_RADIUS = 10;
const COUNT_W = 110;

/** Rendered at 3× so the PNG is ~1920px wide — sharp, and small enough to send. */
const SCALE = 3;

const font = (weight: number, size: number, family: string) =>
  `${weight} ${size}px ${family}`;

/**
 * The panel's own typeface, so the sheet matches the product it came from.
 * Falls back through the system stack when the webfont has not loaded.
 */
function resolveFontFamily(): string {
  if (typeof window === 'undefined') return 'system-ui, sans-serif';
  const body = window.getComputedStyle(document.body).fontFamily;
  return body || 'system-ui, sans-serif';
}

function tableHeight(rows: SheetLine[]): number {
  return TABLE_HEADER_H + (rows.length ? rows.length * ROW_H : EMPTY_H) + TOTAL_H;
}

/** Total sheet height, computed before anything is drawn so the canvas fits. */
export function sheetHeight(opts: SheetOptions): number {
  const hasLetterhead = !!opts.logo || !!(opts.companyName ?? '').trim();
  let h = PAD_TOP;
  if (hasLetterhead) h += LOGO_H + 20;
  h += 34 + 6 + 20 + 26; // title, gap, subtitle, gap
  h += tableHeight(opts.byDesignation);
  if (opts.audience === 'internal') h += 22 + tableHeight(opts.byVendor);
  h += 22 + 16 + PAD_BOTTOM; // gap, footer line, padding
  return h;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: { tl: number; tr: number; br: number; bl: number },
) {
  ctx.beginPath();
  ctx.moveTo(x + r.tl, y);
  ctx.lineTo(x + w - r.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r.tr);
  ctx.lineTo(x + w, y + h - r.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
  ctx.lineTo(x + r.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r.bl);
  ctx.lineTo(x, y + r.tl);
  ctx.quadraticCurveTo(x, y, x + r.tl, y);
  ctx.closePath();
}

/** Cut a name that will not fit, so a long contractor never runs into its count. */
function ellipsise(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** Letter-spaced small caps — canvas has no letterSpacing in older engines. */
function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: 'left' | 'right' = 'left',
) {
  const chars = [...text];
  const width =
    chars.reduce((sum, c) => sum + ctx.measureText(c).width, 0) + tracking * (chars.length - 1);
  let cursor = align === 'right' ? x - width : x;
  const previous = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const c of chars) {
    ctx.fillText(c, cursor, y);
    cursor += ctx.measureText(c).width + tracking;
  }
  ctx.textAlign = previous;
}

function drawTable(
  ctx: CanvasRenderingContext2D,
  family: string,
  title: string,
  rows: SheetLine[],
  top: number,
): number {
  const x = PAD_X;
  const w = WIDTH - PAD_X * 2;
  const total = rows.reduce((a, b) => a + b.count, 0);
  const bodyTop = top + TABLE_HEADER_H;
  const bodyH = (rows.length ? rows.length * ROW_H : EMPTY_H) + TOTAL_H;

  // Header bar.
  ctx.fillStyle = PRIMARY;
  roundedRect(ctx, x, top, w, TABLE_HEADER_H, {
    tl: TABLE_RADIUS,
    tr: TABLE_RADIUS,
    br: 0,
    bl: 0,
  });
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = font(700, 12, family);
  ctx.textBaseline = 'middle';
  drawTracked(ctx, title.toUpperCase(), x + 16, top + TABLE_HEADER_H / 2 + 1, 0.8);
  drawTracked(ctx, 'WORKERS', x + w - 16, top + TABLE_HEADER_H / 2 + 1, 0.8, 'right');

  // Body background + rows.
  let y = bodyTop;
  if (rows.length === 0) {
    ctx.fillStyle = PAPER;
    ctx.fillRect(x, y, w, EMPTY_H);
    ctx.fillStyle = MUTED;
    ctx.font = font(500, 15, family);
    ctx.textAlign = 'left';
    ctx.fillText('Nobody logged in on this day.', x + 16, y + EMPTY_H / 2);
    y += EMPTY_H;
  } else {
    rows.forEach((row, i) => {
      ctx.fillStyle = i % 2 === 1 ? ZEBRA : PAPER;
      ctx.fillRect(x, y, w, ROW_H);

      ctx.fillStyle = INK;
      ctx.font = font(500, 15, family);
      ctx.textAlign = 'left';
      ctx.fillText(
        ellipsise(ctx, row.name, w - 32 - COUNT_W),
        x + 16,
        y + ROW_H / 2,
      );

      ctx.textAlign = 'right';
      ctx.fillText(`${row.count}`, x + w - 16, y + ROW_H / 2);
      y += ROW_H;
    });
  }

  // Total strip.
  ctx.fillStyle = TOTAL_BG;
  roundedRect(ctx, x, y, w, TOTAL_H, { tl: 0, tr: 0, br: TABLE_RADIUS, bl: TABLE_RADIUS });
  ctx.fill();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.5);
  ctx.lineTo(x + w, y + 0.5);
  ctx.stroke();

  ctx.fillStyle = INK;
  ctx.font = font(700, 15, family);
  ctx.textAlign = 'left';
  ctx.fillText('Total', x + 16, y + TOTAL_H / 2);
  ctx.textAlign = 'right';
  ctx.fillText(`${total}`, x + w - 16, y + TOTAL_H / 2);

  // Outline around the body, drawn last so it sits over the fills.
  ctx.strokeStyle = BORDER;
  roundedRect(ctx, x + 0.5, bodyTop + 0.5, w - 1, bodyH - 1, {
    tl: 0,
    tr: 0,
    br: TABLE_RADIUS,
    bl: TABLE_RADIUS,
  });
  ctx.stroke();

  return top + TABLE_HEADER_H + bodyH;
}

/** Draw the sheet and hand back the PNG. */
export async function renderManpowerSheet(opts: SheetOptions): Promise<Blob> {
  const family = resolveFontFamily();
  const height = sheetHeight(opts);

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser would not give us a canvas to draw on.');
  ctx.scale(SCALE, SCALE);

  // Paper. Never transparent: a PNG with an alpha background renders on black
  // in WhatsApp's dark mode, which is where these end up.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, WIDTH, height);

  let y = PAD_TOP;
  const name = (opts.companyName ?? '').trim();

  if (opts.logo || name) {
    let textX = PAD_X;
    if (opts.logo) {
      // Contain inside the logo box, then apply the same print zoom the ID
      // cards use, clipped so a zoomed logo cannot bleed across the header.
      const scale = Math.min(LOGO_W / opts.logo.width, LOGO_H / opts.logo.height);
      const zoom = opts.logoScale ?? 1;
      const dw = opts.logo.width * scale * zoom;
      const dh = opts.logo.height * scale * zoom;
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD_X, y, LOGO_W, LOGO_H);
      ctx.clip();
      ctx.drawImage(
        opts.logo,
        PAD_X + (LOGO_W - dw) / 2,
        y + (LOGO_H - dh) / 2,
        dw,
        dh,
      );
      ctx.restore();
      textX = PAD_X + LOGO_W + 16;
    }
    if (name) {
      ctx.fillStyle = INK;
      ctx.font = font(700, 17, family);
      ctx.textBaseline = 'middle';
      drawTracked(ctx, name.toUpperCase(), textX, y + LOGO_H / 2, 0.6);
    }
    y += LOGO_H + 20;
  }

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = font(700, 27, family);
  ctx.fillText('Daily manpower', PAD_X, y + 27);
  y += 34 + 6;

  ctx.fillStyle = MUTED;
  ctx.font = font(400, 15, family);
  ctx.fillText(
    [opts.siteName, opts.dateLabel].filter(Boolean).join('  ·  '),
    PAD_X,
    y + 15,
  );
  y += 20 + 26;

  y = drawTable(ctx, family, 'Designation', opts.byDesignation, y);
  if (opts.audience === 'internal') {
    y = drawTable(ctx, family, 'Vendor / contractor', opts.byVendor, y + 22);
  }

  // Footer.
  y += 22;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = MUTED;
  ctx.font = font(400, 12, family);
  ctx.textAlign = 'left';
  ctx.fillText(
    opts.audience === 'internal'
      ? 'Internal copy — includes contractor split'
      : 'Manpower summary',
    PAD_X,
    y + 8,
  );
  ctx.font = font(700, 12, family);
  drawTracked(ctx, 'CLAMS', WIDTH - PAD_X, y + 8, 1, 'right');

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The sheet could not be encoded.'))),
      'image/png',
    );
  });
}

/** Load the company logo for the header. Returns null when there isn't one. */
export function loadLogo(src?: string | null): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    // A logo that will not load is not worth failing the whole sheet for.
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Hand the finished sheet to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: Safari cancels the download if the URL dies first.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
