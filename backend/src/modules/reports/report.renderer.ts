import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import { Cell, isNightTime } from './report.builder';

type Row = Cell[];

/**
 * The blue a night shift's times sit ON — a filled cell, not tinted text, so a
 * night shift is visible at arm's length from a printed sheet.
 */
const NIGHT_FILL = '#DCE9F7';
const NIGHT_FILL_ARGB = 'FFDCE9F7';
/** The legend's own ink; the only place the blue is written rather than filled. */
const NIGHT_INK = '#1F5FA8';

/** Renders report rows to an XLSX buffer (in-process — no worker needed). */
export async function renderXlsx(title: string, headers: string[], rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 31) || 'Report');

  const headerRow = ws.addRow(headers);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8EEF7' },
  };
  for (const row of rows) ws.addRow(row.map((c) => (isNightTime(c) ? c.value : c)));

  ws.columns.forEach((col, i) => {
    const headerLen = headers[i]?.length ?? 10;
    col.width = Math.min(32, Math.max(12, headerLen + 4));
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The line above the muster grid that explains what the blue means. */
export const ATT_SHEET_LEGEND =
  'IN and Out are site times, shown under the day the shift STARTED. ' +
  'Times on a blue background are a night shift: its out time falls on the following morning.';

export interface AttSheetMonth {
  label: string;
  /** Day-of-month numbers included for this block (may be a partial month). */
  days: number[];
}
export interface AttSheetRow {
  info: (string | number | null)[];
  cells: Cell[];
  /**
   * The row holds a night shift, so it is filled from the serial number to the
   * out time — the worker's columns as well as the times.
   */
  night?: boolean;
  /**
   * Section divider — when set, the row is a banner spanning the whole sheet
   * ("SECOND LOGIN OF THE DAY") and `info`/`cells` are empty.
   */
  heading?: string;
}

/**
 * Writes the data rows of a muster-roll sheet, starting at `startRow`. Shared by
 * the times and presence layouts, which differ only in how tall their headers
 * are. A row carrying a heading becomes a banner merged across the sheet.
 */
function writeAttSheetRows(
  ws: ExcelJS.Worksheet,
  rows: AttSheetRow[],
  startRow: number,
  infoCols: number,
  lastCol: number,
  thin: Partial<ExcelJS.Borders>,
): void {
  const bannerFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD6E2F2' },
  };
  rows.forEach((row, i) => {
    const r = startRow + i;
    if (row.heading) {
      ws.mergeCells(r, 1, r, lastCol);
      const cell = ws.getCell(r, 1);
      cell.value = row.heading;
      cell.font = { bold: true };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.fill = bannerFill;
      cell.border = thin;
      return;
    }
    const wsRow = ws.getRow(r);
    [...row.info, ...row.cells].forEach((v, j) => {
      const cell = wsRow.getCell(j + 1);
      // A night-shift row is filled end to end, worker columns included, so the
      // band is unbroken; the legend above the grid explains the colour.
      cell.value = (isNightTime(v) ? v.value : v) as ExcelJS.CellValue;
      cell.border = thin;
      if (j >= infoCols) cell.alignment = { horizontal: 'center' };
      if (row.night || isNightTime(v)) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NIGHT_FILL_ARGB } };
      }
    });
  });
}

/**
 * Renders the muster-roll "Attendance" grid: worker-info columns followed by one
 * 2-column (IN/Out) block per day, grouped under per-month headers. Mirrors the
 * layout of the workforce workbook's Attendance sheet.
 *
 * A worker who tapped in more than once on any day of the period gets a further
 * block below the first, one per shift, so a split shift reads as the two
 * stretches it actually was rather than one unbroken run.
 */
export async function renderAttendanceSheetXlsx(
  months: AttSheetMonth[],
  infoHeaders: string[],
  rows: AttSheetRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendance');
  const headerFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8EEF7' },
  };
  const monthFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD6E2F2' },
  };
  const thin: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFBFC7D1' } },
    left: { style: 'thin', color: { argb: 'FFBFC7D1' } },
    bottom: { style: 'thin', color: { argb: 'FFBFC7D1' } },
    right: { style: 'thin', color: { argb: 'FFBFC7D1' } },
  };

  const n = infoHeaders.length;
  // Row 1 is the legend; the four header rows and the data below it all sit one
  // row lower than the plain presence sheet, which needs no explaining.
  const TOP = 2;
  // Info columns: one header each, merged down all four header rows.
  infoHeaders.forEach((h, i) => {
    const c = i + 1;
    ws.mergeCells(TOP, c, TOP + 3, c);
    const cell = ws.getCell(TOP, c);
    cell.value = h;
    cell.font = { bold: true };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.fill = headerFill;
    cell.border = thin;
  });

  // Day blocks, grouped by month.
  let col = n + 1;
  for (const mo of months) {
    const blockStart = col;
    const blockWidth = mo.days.length * 2;
    ws.mergeCells(TOP, blockStart, TOP + 1, blockStart + blockWidth - 1);
    const mcell = ws.getCell(TOP, blockStart);
    mcell.value = mo.label;
    mcell.font = { bold: true };
    mcell.alignment = { horizontal: 'center', vertical: 'middle' };
    mcell.fill = monthFill;
    mcell.border = thin;
    for (const day of mo.days) {
      ws.mergeCells(TOP + 2, col, TOP + 2, col + 1);
      const dcell = ws.getCell(TOP + 2, col);
      dcell.value = day;
      dcell.font = { bold: true };
      dcell.alignment = { horizontal: 'center' };
      dcell.fill = headerFill;
      dcell.border = thin;
      const inCell = ws.getCell(TOP + 3, col);
      inCell.value = 'IN';
      const outCell = ws.getCell(TOP + 3, col + 1);
      outCell.value = 'Out';
      for (const hc of [inCell, outCell]) {
        hc.font = { bold: true, size: 9 };
        hc.alignment = { horizontal: 'center' };
        hc.fill = headerFill;
        hc.border = thin;
      }
      col += 2;
    }
  }
  const lastCol = col - 1;

  // The legend, written last so it can span every column the grid ended up with.
  ws.mergeCells(1, 1, 1, lastCol);
  const legend = ws.getCell(1, 1);
  legend.value = ATT_SHEET_LEGEND;
  legend.font = { italic: true, size: 10, color: { argb: 'FF1F5FA8' } };
  legend.alignment = { vertical: 'middle', horizontal: 'left' };

  // Data rows start below the legend and the four header rows.
  writeAttSheetRows(ws, rows, TOP + 4, n, lastCol, thin);

  for (let c = 1; c <= n; c++) ws.getColumn(c).width = c === 1 ? 6 : 16;
  // A clock time and nothing more — the next-morning ones are told apart by
  // colour, so no column has to widen to carry a marker.
  for (let c = n + 1; c <= lastCol; c++) ws.getColumn(c).width = 6;
  ws.views = [{ state: 'frozen', xSplit: n, ySplit: TOP + 3 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Renders the muster-roll grid in PRESENCE mode: worker-info columns followed by
 * one column per day holding P (present) / A (absent) / blank (not employed),
 * grouped under per-month headers. Three header rows: month, day, then data.
 */
export async function renderPresenceSheetXlsx(
  months: AttSheetMonth[],
  infoHeaders: string[],
  rows: AttSheetRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendance');
  const headerFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8EEF7' },
  };
  const monthFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD6E2F2' },
  };
  const thin: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFBFC7D1' } },
    left: { style: 'thin', color: { argb: 'FFBFC7D1' } },
    bottom: { style: 'thin', color: { argb: 'FFBFC7D1' } },
    right: { style: 'thin', color: { argb: 'FFBFC7D1' } },
  };

  const n = infoHeaders.length;
  // Info columns: one header each, merged down both header rows (month + day).
  infoHeaders.forEach((h, i) => {
    const c = i + 1;
    ws.mergeCells(1, c, 2, c);
    const cell = ws.getCell(1, c);
    cell.value = h;
    cell.font = { bold: true };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.fill = headerFill;
    cell.border = thin;
  });

  // One column per day, grouped by month.
  let col = n + 1;
  for (const mo of months) {
    const blockStart = col;
    ws.mergeCells(1, blockStart, 1, blockStart + mo.days.length - 1);
    const mcell = ws.getCell(1, blockStart);
    mcell.value = mo.label;
    mcell.font = { bold: true };
    mcell.alignment = { horizontal: 'center', vertical: 'middle' };
    mcell.fill = monthFill;
    mcell.border = thin;
    for (const day of mo.days) {
      const dcell = ws.getCell(2, col);
      dcell.value = day;
      dcell.font = { bold: true, size: 9 };
      dcell.alignment = { horizontal: 'center' };
      dcell.fill = headerFill;
      dcell.border = thin;
      col += 1;
    }
  }
  const lastCol = col - 1;

  // Data rows start at row 3 (after the two header rows).
  writeAttSheetRows(ws, rows, 3, n, lastCol, thin);

  for (let c = 1; c <= n; c++) ws.getColumn(c).width = c === 1 ? 6 : 16;
  for (let c = n + 1; c <= lastCol; c++) ws.getColumn(c).width = 4;
  ws.views = [{ state: 'frozen', xSplit: n, ySplit: 2 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface ManpowerReport {
  reportType: string;
  periodLabel: string;
  days: string[];
  trend: number[];
  periodFrom: string;
  totalManDays: number;
  uniqueWorkers: number;
  manHours: number;
  activeTrades: number;
  avgPerDay: number;
  peak: number;
  byTrade: { name: string; count: number }[];
  byVendor: { name: string; count: number }[];
}

/**
 * Report theme — the dark surfaces of the admin panel, so a PDF landing in a
 * client's inbox reads as the same product they were shown on screen.
 *
 * PAGE is the plane; PANEL is the card that lifts off it. The gap between the
 * two is what carries elevation on a dark ground, where a shadow is invisible.
 */
const PAGE = '#060D13';
const PANEL = '#141F29';
const PANEL_EDGE = '#243342';
const INK = '#E9EFF2';
const INK_2 = '#95A8B3';
const INK_3 = '#6E828F';
const GRID = '#1F2E3A';

/**
 * Categorical series hues, validated as a set against the PANEL surface with
 * the data-viz palette checker (dark band, adjacent pairlist): worst adjacent
 * CVD ΔE 14.7, worst normal-vision ΔE 22.5, all eight ≥ 3:1 on the panel.
 *
 * The order is the colour-blind-safety mechanism, not decoration — it was
 * picked by searching orderings and keeping only those that clear every gate.
 * Re-run the checker before touching either the hues or their sequence.
 */
const SERIES = [
  '#0EA3B0',
  '#E85E4C',
  '#B16DDF',
  '#BD8407',
  '#009AE2',
  '#16AD52',
  '#6D85FA',
  '#DD5B9C',
];
/** The lead hue: single-series charts are all drawn in it. */
const ACCENT = SERIES[0];

type Doc = PDFKit.PDFDocument;

/** Optispace wordmark, ~2.58:1. Copied into dist by the nest-cli assets glob. */
const LOGO_PATH = join(__dirname, '../../assets/logo.png');
const LOGO_RATIO = 1129 / 437;
let logoBuf: Buffer | null | undefined;

function loadLogo(): Buffer | null {
  if (logoBuf === undefined) {
    logoBuf = existsSync(LOGO_PATH) ? readFileSync(LOGO_PATH) : null;
  }
  return logoBuf;
}

/**
 * Draws the wordmark with its right edge at `right` and the given height,
 * returning the width it consumed (0 when the asset is missing — a branding
 * flourish must never fail a report).
 */
function drawLogo(doc: Doc, right: number, y: number, h: number): number {
  const buf = loadLogo();
  if (!buf) return 0;
  const w = h * LOGO_RATIO;
  doc.image(buf, right - w, y, { height: h });
  return w;
}

/**
 * pdfkit loops forever laying text out in a box narrower than a single glyph,
 * so every computed text width goes through this floor.
 */
const textW = (w: number) => Math.max(8, w);

/** Thousands-separated integer, for axis ticks and values. */
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Shorten `s` with an ellipsis until it fits `maxW` at the font currently set
 * on the document.
 *
 * pdfkit's own `ellipsis` option only applies inside its line wrapper, which
 * `lineBreak: false` bypasses — so the two together silently do nothing and a
 * long contractor name wraps onto a second line, over the row beneath it.
 * Measuring here is the only way to be sure a label is one line and inside its
 * column.
 */
function fitText(doc: Doc, s: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (doc.widthOfString(s) <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(`${s.slice(0, mid).trimEnd()}…`) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${s.slice(0, lo).trimEnd()}…` : '';
}

/**
 * A bar rounded on its data-end only and square at the baseline, so the mark
 * grows out of the axis instead of floating free of it. `side` names the end
 * the value grows towards.
 */
function barPath(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  side: 'right' | 'top',
): void {
  const rr = Math.max(0, Math.min(r, side === 'right' ? w : h, side === 'right' ? h / 2 : w / 2));
  if (side === 'right') {
    doc
      .moveTo(x, y)
      .lineTo(x + w - rr, y)
      .quadraticCurveTo(x + w, y, x + w, y + rr)
      .lineTo(x + w, y + h - rr)
      .quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
      .lineTo(x, y + h)
      .closePath();
    return;
  }
  doc
    .moveTo(x, y + h)
    .lineTo(x, y + rr)
    .quadraticCurveTo(x, y, x + rr, y)
    .lineTo(x + w - rr, y)
    .quadraticCurveTo(x + w, y, x + w, y + rr)
    .lineTo(x + w, y + h)
    .closePath();
}

/**
 * Card frame with a title and subtitle, returning the inner drawing box.
 *
 * The card is filled a step above the page rather than merely outlined: on a
 * dark ground the surface step is what reads as elevation, and a hairline alone
 * leaves the panel dissolving into the background.
 */
function panel(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  subtitle?: string,
) {
  doc.roundedRect(x, y, w, h, 10).fillColor(PANEL).fill();
  doc.roundedRect(x, y, w, h, 10).lineWidth(0.7).strokeColor(PANEL_EDGE).stroke();
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK);
  doc.text(fitText(doc, title, w - 36), x + 18, y + 16, {
    width: textW(w - 36),
    lineBreak: false,
  });
  if (subtitle) {
    doc.font('Helvetica').fontSize(7).fillColor(INK_3);
    // The tracking below widens the run past what widthOfString measures, so
    // fit against a slightly tighter box than the one it is drawn into.
    doc.text(fitText(doc, subtitle.toUpperCase(), w - 44), x + 18, y + 30, {
      width: textW(w - 36),
      lineBreak: false,
      characterSpacing: 0.6,
    });
  }
  const top = subtitle ? 50 : 38;
  return { x: x + 18, y: y + top, w: w - 36, h: h - top - 18 };
}

/** Centred muted line for a panel with nothing to draw. */
function emptyPanel(doc: Doc, box: { x: number; y: number; w: number; h: number }, msg: string) {
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(INK_3)
    .text(msg, box.x, box.y + box.h / 2 - 5, { width: textW(box.w), align: 'center' });
}

/**
 * A y-axis that lands on round numbers.
 *
 * Picking a ceiling first and dividing it into a fixed number of bands is what
 * printed "0 17 33 50" on a peak of 50 — the ceiling was round but the step was
 * not. This picks the *step* from the 1/2/2.5/5 series instead and lets the
 * ceiling and band count fall out of it, so every tick is a number a reader
 * recognises.
 */
function niceScale(peak: number, targetBands = 4): { ceiling: number; bands: number } {
  if (peak <= 0) return { ceiling: 1, bands: 1 };
  const raw = peak / targetBands;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((c) => c >= raw - 1e-9) ?? 10 * pow;
  const ceiling = Math.ceil(peak / step) * step;
  // Sub-unit steps would tick 0.5 people; a count axis stays whole.
  if (step < 1)
    return { ceiling: Math.max(1, Math.ceil(peak)), bands: Math.max(1, Math.ceil(peak)) };
  return { ceiling, bands: Math.max(1, Math.round(ceiling / step)) };
}

/**
 * Daily manpower as an area + line. One series, so no legend — the panel title
 * already says what is plotted — and labels are spent only where they earn
 * their ink: the peak, and the two ends of the period.
 */
function drawTrend(
  doc: Doc,
  box: { x: number; y: number; w: number; h: number },
  r: ManpowerReport,
) {
  const { x, y, w, h } = box;
  const n = r.trend.length;
  const peakValue = Math.max(...r.trend, 0);
  // A flat line pinned to zero says nothing a sentence cannot say better.
  if (n === 0 || peakValue === 0) {
    return emptyPanel(doc, box, 'No labour attendance in this period');
  }

  // Reserve a gutter for the y-axis ticks and a band for the date labels.
  const gutter = 30;
  const xBand = 16;
  const plot = { x: x + gutter, y, w: w - gutter, h: h - xBand };
  const { ceiling: max, bands } = niceScale(peakValue);
  const scaleY = (v: number) => plot.y + plot.h - (v / max) * plot.h;
  const stepX = n > 1 ? plot.w / (n - 1) : 0;
  const px = (i: number) => (n > 1 ? plot.x + i * stepX : plot.x + plot.w / 2);

  // Hairline guides on the scale's own steps, with the tick beside each.
  doc.lineWidth(0.5);
  for (let g = 0; g <= bands; g++) {
    const v = (max / bands) * g;
    const gy = scaleY(v);
    doc
      .strokeColor(GRID)
      .moveTo(plot.x, gy)
      .lineTo(plot.x + plot.w, gy)
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(INK_3)
      .text(fmt(v), x, gy - 3, {
        width: textW(gutter - 8),
        align: 'right',
        lineBreak: false,
      });
  }

  const pts = r.trend.map((v, i) => ({ px: px(i), py: scaleY(v) }));

  // Area wash. Deliberately a flat low-opacity fill rather than a gradient:
  // pdfkit expresses gradient-stop alpha as a soft mask, which not every PDF
  // viewer honours, and one that silently ignores it renders this as a solid
  // saturated block — the exact thing the wash exists to avoid.
  doc.save();
  doc.moveTo(pts[0].px, plot.y + plot.h);
  pts.forEach((p) => doc.lineTo(p.px, p.py));
  doc
    .lineTo(pts[n - 1].px, plot.y + plot.h)
    .closePath()
    .fillColor(ACCENT)
    .fillOpacity(0.16)
    .fill();
  doc.restore();
  doc.fillOpacity(1);

  doc.lineWidth(2).strokeColor(ACCENT).lineJoin('round').lineCap('round');
  pts.forEach((p, i) => (i === 0 ? doc.moveTo(p.px, p.py) : doc.lineTo(p.px, p.py)));
  doc.stroke();

  // Date ticks along the foot, thinned so a month does not collide.
  const every = Math.max(1, Math.ceil(n / 10));
  r.days.forEach((day, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    const d = new Date(`${day}T00:00:00.000Z`);
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(INK_3)
      .text(
        d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
        px(i) - 18,
        plot.y + plot.h + 6,
        { width: 36, align: 'center', lineBreak: false },
      );
  });

  // Label the peak and the two ends only. A marker carries a 2px ring in the
  // panel colour so it stays legible where it sits on the line.
  const peakIdx = r.trend.indexOf(Math.max(...r.trend));
  const marked = new Set([0, n - 1, peakIdx]);
  for (const i of [...marked].sort((a, b) => a - b)) {
    const p = pts[i];
    doc.circle(p.px, p.py, 4.5).fillColor(PANEL).fill();
    doc.circle(p.px, p.py, 3).fillColor(ACCENT).fill();
    // Nudge the end labels inwards so neither runs off the plot.
    const lw = 40;
    let lx = p.px - lw / 2;
    if (i === 0) lx = p.px - 4;
    if (i === n - 1) lx = p.px - lw + 4;
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(i === peakIdx ? INK : INK_2)
      .text(fmt(r.trend[i]), lx, p.py - 14, {
        width: lw,
        align: i === 0 ? 'left' : i === n - 1 ? 'right' : 'center',
        lineBreak: false,
      });
  }
}

/**
 * Ranked horizontal bars. Trade names are long and read far better beside the
 * bar than rotated under a column, and the ranking is the whole story.
 *
 * One measure, so one colour for every bar: colouring by rank would double-
 * encode the length as hue and burn the only free channel on nothing.
 */
function drawBars(
  doc: Doc,
  box: { x: number; y: number; w: number; h: number },
  items: { name: string; count: number }[],
) {
  const { x, y, w, h } = box;
  if (items.length === 0) return emptyPanel(doc, box, 'No labour attendance in this period');

  // Rows breathe to fill the panel rather than bunching at the top and leaving
  // a dead third below — capped so four trades do not become four fat bands.
  const count = Math.max(1, Math.min(items.length, Math.floor(h / 18)));
  const rowH = Math.max(18, Math.min(30, h / count));
  const shown = items.slice(0, count);
  const max = Math.max(...shown.map((i) => i.count), 1);
  const labelW = Math.min(96, w * 0.4);
  const valueW = 30;
  const trackX = x + labelW + 8;
  const trackW = Math.max(10, w - labelW - valueW - 16);
  const barH = Math.min(11, rowH - 9);

  shown.forEach((item, i) => {
    const cy = y + i * rowH;
    const by = cy + (rowH - barH) / 2 - 2;
    doc.font('Helvetica').fontSize(7.5).fillColor(INK_2);
    doc.text(fitText(doc, item.name, labelW), x, by + 1, {
      width: textW(labelW),
      lineBreak: false,
    });
    // Track, so a short bar still reads against the full scale.
    barPath(doc, trackX, by, trackW, barH, 4, 'right');
    doc.fillColor(GRID).fill();
    const bw = Math.max(2, (item.count / max) * trackW);
    barPath(doc, trackX, by, bw, barH, 4, 'right');
    doc.fillColor(ACCENT).fill();
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(INK)
      .text(fmt(item.count), trackX + trackW + 8, by + 1, {
        width: textW(valueW),
        align: 'right',
        lineBreak: false,
      });
  });
}

/**
 * Contractor split as a single 100% share bar over a ranked legend.
 *
 * A donut was the obvious choice and the wrong one: it sets every slice against
 * every other, so the tail contractors — routinely 3% and 3% — have to be told
 * apart by hue alone at a size where no palette can do it. One share bar reads
 * the same part-to-whole story left to right, and the rows underneath give the
 * exact percentage and man-days that a slice never could.
 *
 * The tail past seven folds into "Other" rather than reaching for a ninth hue.
 */
function drawShare(
  doc: Doc,
  box: { x: number; y: number; w: number; h: number },
  items: { name: string; count: number }[],
) {
  const { x, y, w, h } = box;
  const total = items.reduce((a, b) => a + b.count, 0);
  if (total === 0) return emptyPanel(doc, box, 'No labour attendance in this period');

  const head = items.slice(0, 7);
  const rest = total - head.reduce((a, b) => a + b.count, 0);
  const parts = rest > 0 ? [...head, { name: 'Other', count: rest }] : head;

  // ---- the share bar ----
  const barH = 14;
  const gap = 2; // surface gap: white does the separating, never a stroke
  const usable = w - gap * (parts.length - 1);
  let bx = x;
  parts.forEach((p, i) => {
    const seg = Math.max(1.5, (p.count / total) * usable);
    const first = i === 0;
    const last = i === parts.length - 1;
    const r = 3;
    // Round only the outer ends so the bar reads as one object.
    if (first || last) {
      doc.save();
      doc.roundedRect(bx, y, seg, barH, r).clip();
      doc
        .rect(first ? bx : bx - r, y, seg + r, barH)
        .fillColor(SERIES[i % SERIES.length])
        .fill();
      doc.restore();
    } else {
      doc
        .rect(bx, y, seg, barH)
        .fillColor(SERIES[i % SERIES.length])
        .fill();
    }
    bx += seg + gap;
  });

  // ---- ranked legend: swatch · name · share · man-days ----
  const top = y + barH + 14;
  const room = Math.max(0, h - (barH + 14));
  const shownCount = Math.max(1, Math.min(parts.length, Math.floor(room / 15)));
  const rowH = Math.max(15, Math.min(26, room / shownCount));
  const rows = parts.slice(0, shownCount);
  const pctW = 30;
  const valW = 34;
  const nameW = Math.max(20, w - 12 - pctW - valW - 14);

  rows.forEach((p, i) => {
    const ry = top + i * rowH;
    doc
      .roundedRect(x, ry + 3, 7, 7, 2)
      .fillColor(SERIES[i % SERIES.length])
      .fill();
    doc.font('Helvetica').fontSize(7.5).fillColor(INK_2);
    doc.text(fitText(doc, p.name, nameW), x + 12, ry + 2, {
      width: textW(nameW),
      lineBreak: false,
    });
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(INK)
      .text(`${Math.round((p.count / total) * 100)}%`, x + 12 + nameW, ry + 2, {
        width: textW(pctW),
        align: 'right',
        lineBreak: false,
      });
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(INK_3)
      .text(fmt(p.count), x + 12 + nameW + pctW, ry + 2, {
        width: textW(valW),
        align: 'right',
        lineBreak: false,
      });
  });
}

/**
 * Renders the manpower report as a one-page landscape A4 dashboard on the dark
 * surfaces of the admin panel: a header band, the daily trend across the full
 * width, then the trade ranking and the contractor split side by side.
 *
 * There are deliberately no headline tiles. The period's totals belong to the
 * covering note and the CSV; a client opening this wants to see the shape of
 * the labour on site, and six big numbers above the charts were competing with
 * it. Drawn with pdfkit vectors — no chart library or headless browser.
 */
export function renderManpowerPdf(r: ManpowerReport, orgName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const M = 30;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentW = pageW - M * 2;

    // ---- Page plane ----
    doc.rect(0, 0, pageW, pageH).fillColor(PAGE).fill();

    // ---- Header ----
    const headH = 74;
    doc.rect(0, 0, pageW, headH).fillColor('#0A131A').fill();
    const titleW = contentW * 0.55;
    const title = `${r.reportType[0]}${r.reportType.slice(1).toLowerCase()} manpower report`;
    doc.font('Helvetica-Bold').fontSize(17).fillColor(INK);
    doc.text(fitText(doc, title, titleW), M, 22, { width: titleW, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(INK_3);
    doc.text(fitText(doc, orgName.toUpperCase(), titleW - 10), M, 45, {
      width: titleW,
      lineBreak: false,
      characterSpacing: 0.7,
    });

    const logoW = drawLogo(doc, pageW - M, 18, 17);
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor(INK_2)
      .text(r.periodLabel, M + contentW * 0.55, 45, {
        width: contentW * 0.45,
        align: 'right',
        lineBreak: false,
      });
    // Accent rule: a thin lead-hue underline, brand rather than chart furniture.
    doc.rect(0, headH, pageW, 1.6).fillColor(ACCENT).fill();
    void logoW;

    // ---- Charts ----
    const gap = 14;
    const topY = headH + 18;
    const trendH = 212;

    drawTrend(
      doc,
      panel(
        doc,
        M,
        topY,
        contentW,
        trendH,
        'Daily manpower',
        `${r.days.length} day${r.days.length === 1 ? '' : 's'} · labour on site per day`,
      ),
      r,
    );

    const lowY = topY + trendH + gap;
    const lowH = pageH - lowY - 36;
    const halfW = (contentW - gap) / 2;

    drawBars(
      doc,
      panel(doc, M, lowY, halfW, lowH, 'Workforce by trade', 'Man-days in this period'),
      r.byTrade,
    );
    drawShare(
      doc,
      panel(
        doc,
        M + halfW + gap,
        lowY,
        halfW,
        lowH,
        'Workforce by contractor',
        'Share of man-days',
      ),
      r.byVendor,
    );

    // ---- Footer ----
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(INK_3)
      .text(
        `Generated ${new Date().toLocaleString('en-GB', { timeZone: 'UTC' })} UTC · ` +
          'labour only, excludes staff and visitors · man-days count attendance sessions',
        M,
        pageH - 26,
        { width: contentW, lineBreak: false },
      );

    doc.end();
  });
}

export interface DaySummaryGroup {
  name: string;
  /** People who logged in at all today. */
  count: number;
  /** Of those, how many are still on site. */
  active: number;
}
export interface DaySummaryReport {
  /** ISO date (YYYY-MM-DD) the summary covers. */
  date: string;
  total: number;
  activeNow: number;
  byDesignation: DaySummaryGroup[];
  byVendor: DaySummaryGroup[];
}

/**
 * One breakdown table: group, logged in, on site now, then a totals row.
 *
 * Returns the y it finished at so the caller can stack the next block, and
 * takes a page-break callback because a site with forty designations will not
 * fit on one sheet and silently dropping the tail would be worse than a second
 * page.
 */
function drawSummaryTable(
  doc: Doc,
  opts: {
    x: number;
    y: number;
    w: number;
    groupHeader: string;
    rows: DaySummaryGroup[];
    bottom: number;
    onBreak: () => number;
  },
): number {
  const { x, w, groupHeader, rows, bottom, onBreak } = opts;
  let y = opts.y;
  const rowH = 19;
  const numW = 74;
  const nameW = w - numW * 2 - 24;

  const header = () => {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(INK_3);
    doc.text(groupHeader.toUpperCase(), x + 12, y + 6, {
      width: textW(nameW),
      lineBreak: false,
      characterSpacing: 0.6,
    });
    doc.text('LOGGED IN', x + 12 + nameW, y + 6, {
      width: textW(numW),
      align: 'right',
      lineBreak: false,
      characterSpacing: 0.6,
    });
    doc.text('ON SITE NOW', x + 12 + nameW + numW, y + 6, {
      width: textW(numW),
      align: 'right',
      lineBreak: false,
      characterSpacing: 0.6,
    });
    y += rowH;
    doc
      .lineWidth(0.7)
      .strokeColor(PANEL_EDGE)
      .moveTo(x + 12, y - 3)
      .lineTo(x + w - 12, y - 3)
      .stroke();
  };

  header();

  for (const r of rows) {
    if (y + rowH > bottom) {
      y = onBreak();
      header();
    }
    doc.font('Helvetica').fontSize(8.5).fillColor(INK);
    doc.text(fitText(doc, r.name, nameW), x + 12, y + 4, {
      width: textW(nameW),
      lineBreak: false,
    });
    doc.fillColor(INK_2);
    doc.text(fmt(r.count), x + 12 + nameW, y + 4, {
      width: textW(numW),
      align: 'right',
      lineBreak: false,
    });
    // On-site-now is the number a Safety Officer acts on, so it stays lit while
    // the rest of the row recedes; zero is muted rather than shouting a red.
    doc
      .font('Helvetica-Bold')
      .fillColor(r.active > 0 ? ACCENT : INK_3)
      .text(fmt(r.active), x + 12 + nameW + numW, y + 4, {
        width: textW(numW),
        align: 'right',
        lineBreak: false,
      });
    y += rowH;
  }

  // Totals. Counts are per group, and one person can hold only one designation
  // or one contractor, so summing the column is sound.
  const totC = rows.reduce((a, b) => a + b.count, 0);
  const totA = rows.reduce((a, b) => a + b.active, 0);
  doc
    .lineWidth(0.7)
    .strokeColor(PANEL_EDGE)
    .moveTo(x + 12, y + 1)
    .lineTo(x + w - 12, y + 1)
    .stroke();
  y += 5;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
  doc.text('Total', x + 12, y + 4, { width: textW(nameW), lineBreak: false });
  doc.text(fmt(totC), x + 12 + nameW, y + 4, {
    width: textW(numW),
    align: 'right',
    lineBreak: false,
  });
  doc.text(fmt(totA), x + 12 + nameW + numW, y + 4, {
    width: textW(numW),
    align: 'right',
    lineBreak: false,
  });
  return y + rowH;
}

/**
 * The Safety Officer's day sheet: who logged in today and who is still on site,
 * split by designation and by contractor.
 *
 * Portrait rather than the landscape of the manpower report — this one is read
 * on a phone and printed for a gate file, and the two breakdowns are lists, not
 * charts. Long lists roll onto further pages rather than being truncated.
 */
export function renderDaySummaryPdf(
  r: DaySummaryReport,
  orgName: string,
  siteName?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const M = 30;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentW = pageW - M * 2;
    const bottom = pageH - 42;

    const pretty = new Date(`${r.date}T00:00:00.000Z`).toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });

    const paintPage = () => {
      doc.rect(0, 0, pageW, pageH).fillColor(PAGE).fill();
    };
    const newPage = () => {
      doc.addPage();
      paintPage();
      return M + 16;
    };

    paintPage();

    // ---- Header ----
    const headH = 78;
    doc.rect(0, 0, pageW, headH).fillColor('#0A131A').fill();
    doc.font('Helvetica-Bold').fontSize(15).fillColor(INK);
    doc.text(fitText(doc, 'Attendance summary', contentW * 0.6), M, 20, {
      width: contentW * 0.6,
      lineBreak: false,
    });
    doc.font('Helvetica').fontSize(8).fillColor(INK_3);
    doc.text(
      fitText(doc, [orgName, siteName].filter(Boolean).join(' · ').toUpperCase(), contentW * 0.6),
      M,
      41,
      { width: contentW * 0.6, lineBreak: false, characterSpacing: 0.7 },
    );
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK_2);
    doc.text(pretty, M + contentW * 0.6, 41, {
      width: contentW * 0.4,
      align: 'right',
      lineBreak: false,
    });
    drawLogo(doc, pageW - M, 16, 16);
    doc.rect(0, headH, pageW, 1.6).fillColor(ACCENT).fill();

    // ---- Headline pair ----
    // Two numbers, not a tile row: "how many came" and "how many are still
    // here" are the whole question at a gate, and the gap between them is the
    // one figure a Safety Officer is actually scanning for.
    let y = headH + 20;
    const stripH = 54;
    doc.roundedRect(M, y, contentW, stripH, 10).fillColor(PANEL).fill();
    doc.roundedRect(M, y, contentW, stripH, 10).lineWidth(0.7).strokeColor(PANEL_EDGE).stroke();
    const halves: [string, number, string][] = [
      ['Logged in today', r.total, INK],
      ['On site now', r.activeNow, ACCENT],
    ];
    halves.forEach(([label, value, colour], i) => {
      const hx = M + 18 + (contentW / 2) * i;
      doc.font('Helvetica').fontSize(7).fillColor(INK_3);
      doc.text(label.toUpperCase(), hx, y + 13, {
        width: textW(contentW / 2 - 24),
        lineBreak: false,
        characterSpacing: 0.6,
      });
      doc
        .font('Helvetica-Bold')
        .fontSize(19)
        .fillColor(colour)
        .text(fmt(value), hx, y + 25, { width: textW(contentW / 2 - 24), lineBreak: false });
    });
    if (contentW > 0) {
      doc
        .lineWidth(0.7)
        .strokeColor(PANEL_EDGE)
        .moveTo(M + contentW / 2, y + 12)
        .lineTo(M + contentW / 2, y + stripH - 12)
        .stroke();
    }
    y += stripH + 16;

    // ---- Breakdowns ----
    const blocks: [string, string, DaySummaryGroup[]][] = [
      ['By designation', 'Designation', r.byDesignation],
      ['By vendor / contractor', 'Vendor', r.byVendor],
    ];
    for (const [title, groupHeader, rows] of blocks) {
      if (y + 90 > bottom) y = newPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
      doc.text(title, M, y, { width: textW(contentW), lineBreak: false });
      y += 18;
      if (rows.length === 0) {
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(INK_3)
          .text('No logins recorded today.', M, y + 2, { width: textW(contentW) });
        y += 28;
        continue;
      }
      y = drawSummaryTable(doc, {
        x: M,
        y,
        w: contentW,
        groupHeader,
        rows,
        bottom,
        onBreak: newPage,
      });
      y += 18;
    }

    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor(INK_3)
      .text(
        `Generated ${new Date().toLocaleString('en-GB', { timeZone: 'UTC' })} UTC · ` +
          'a person is counted once however many times they scanned',
        M,
        pageH - 26,
        { width: contentW, lineBreak: false },
      );

    doc.end();
  });
}

export interface SafetyPdfReport {
  periodLabel: string;
  from: string;
  to: string;
  siteName: string | null;
  kpis: {
    dailyManpower: number;
    totalManpower: number;
    totalSafeManHours: number;
    safetyPerformance: number | null;
    safetyPerformanceTarget: number;
  };
  trend: { days: string[]; series: { label: string; values: number[] }[] };
  observations: { bucket: string; raised: number; closed: number }[];
  statistics: { label: string; kind: string; value: number }[];
  categoryBreakup: { rows: { label: string; value: number; percent: number }[] };
}

/** Headline tile for the safety sheet. */
function drawKpiTile(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  accent: string,
) {
  doc.roundedRect(x, y, w, h, 10).fillColor(PANEL).fill();
  doc.roundedRect(x, y, w, h, 10).lineWidth(0.7).strokeColor(PANEL_EDGE).stroke();
  // A short accent bar rather than a coloured card: the number is the content.
  doc
    .roundedRect(x + 14, y + 14, 3, h - 28, 1.5)
    .fillColor(accent)
    .fill();
  doc.font('Helvetica').fontSize(7).fillColor(INK_3);
  doc.text(fitText(doc, label.toUpperCase(), w - 40), x + 24, y + 15, {
    width: textW(w - 34),
    lineBreak: false,
    characterSpacing: 0.6,
  });
  doc.font('Helvetica-Bold').fontSize(19).fillColor(INK);
  doc.text(fitText(doc, value, w - 34), x + 24, y + 29, { width: textW(w - 34), lineBreak: false });
}

/** Multi-series line chart for the safety trend. */
function drawMultiLine(
  doc: Doc,
  box: { x: number; y: number; w: number; h: number },
  days: string[],
  series: { label: string; values: number[] }[],
) {
  const { x, y, w, h } = box;
  const flat = series.flatMap((s) => s.values);
  if (days.length === 0 || flat.length === 0 || Math.max(...flat) === 0) {
    return emptyPanel(doc, box, 'Nothing recorded in this period');
  }

  const legendH = 14;
  const gutter = 26;
  const xBand = 14;
  const plot = { x: x + gutter, y: y + legendH, w: w - gutter, h: h - legendH - xBand };
  const { ceiling: max, bands } = niceScale(Math.max(...flat), 3);
  const scaleY = (v: number) => plot.y + plot.h - (v / max) * plot.h;
  const n = days.length;
  const px = (i: number) => (n > 1 ? plot.x + (i * plot.w) / (n - 1) : plot.x + plot.w / 2);

  // Legend across the top — three series, so identity cannot rest on colour.
  let lx = x + gutter;
  series.forEach((s, i) => {
    const colour = SERIES[i % SERIES.length];
    doc
      .roundedRect(lx, y + 3, 7, 3, 1.5)
      .fillColor(colour)
      .fill();
    doc.font('Helvetica').fontSize(6.5).fillColor(INK_2);
    const label = fitText(doc, s.label, 90);
    doc.text(label, lx + 11, y + 1, { width: textW(92), lineBreak: false });
    lx += 11 + doc.widthOfString(label) + 12;
  });

  doc.lineWidth(0.5);
  for (let g = 0; g <= bands; g++) {
    const v = (max / bands) * g;
    const gy = scaleY(v);
    doc
      .strokeColor(GRID)
      .moveTo(plot.x, gy)
      .lineTo(plot.x + plot.w, gy)
      .stroke();
    doc.font('Helvetica').fontSize(6).fillColor(INK_3);
    doc.text(fmt(v), x, gy - 3, { width: textW(gutter - 6), align: 'right', lineBreak: false });
  }

  series.forEach((s, i) => {
    doc
      .lineWidth(1.6)
      .strokeColor(SERIES[i % SERIES.length])
      .lineJoin('round')
      .lineCap('round');
    s.values.forEach((v, k) =>
      k === 0 ? doc.moveTo(px(k), scaleY(v)) : doc.lineTo(px(k), scaleY(v)),
    );
    doc.stroke();
  });

  const every = Math.max(1, Math.ceil(n / 8));
  days.forEach((day, i) => {
    if (i % every !== 0 && i !== n - 1) return;
    const d = new Date(`${day}T00:00:00.000Z`);
    doc.font('Helvetica').fontSize(6).fillColor(INK_3);
    doc.text(
      d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      px(i) - 16,
      plot.y + plot.h + 5,
      { width: 32, align: 'center', lineBreak: false },
    );
  });
}

/** Raised against closed, grouped by window. */
function drawGroupedBars(
  doc: Doc,
  box: { x: number; y: number; w: number; h: number },
  rows: { bucket: string; raised: number; closed: number }[],
) {
  const { x, y, w, h } = box;
  const max = Math.max(...rows.flatMap((r) => [r.raised, r.closed]), 0);
  if (rows.length === 0 || max === 0) {
    return emptyPanel(doc, box, 'Nothing raised in this period');
  }
  const RAISED = '#E0A438';
  const CLOSED = '#16AD52';

  const legendH = 14;
  const xBand = 14;
  const plot = { x, y: y + legendH, w, h: h - legendH - xBand };
  const { ceiling } = niceScale(max);
  const scaleY = (v: number) => plot.y + plot.h - (v / ceiling) * plot.h;

  let lx = x;
  for (const [label, colour] of [
    ['Raised', RAISED],
    ['Closed', CLOSED],
  ] as const) {
    doc
      .roundedRect(lx, y + 2, 7, 5, 1.5)
      .fillColor(colour)
      .fill();
    doc.font('Helvetica').fontSize(6.5).fillColor(INK_2);
    doc.text(label, lx + 11, y + 1, { width: textW(40), lineBreak: false });
    lx += 11 + doc.widthOfString(label) + 12;
  }

  const slot = plot.w / rows.length;
  const barW = Math.min(16, slot * 0.28);
  rows.forEach((r, i) => {
    const centre = plot.x + slot * i + slot / 2;
    (
      [
        [r.raised, RAISED, -1],
        [r.closed, CLOSED, 1],
      ] as const
    ).forEach(([v, colour, side]) => {
      const bh = Math.max(1.5, plot.y + plot.h - scaleY(v));
      // A 2px gap between the pair: surface does the separating, not a stroke.
      const bx = centre + side * 1 + (side < 0 ? -barW : 0);
      barPath(doc, bx, plot.y + plot.h - bh, barW, bh, 3, 'top');
      doc.fillColor(colour).fill();
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(INK_2);
      doc.text(fmt(v), bx - 4, plot.y + plot.h - bh - 9, {
        width: barW + 8,
        align: 'center',
        lineBreak: false,
      });
    });
    doc.font('Helvetica').fontSize(6.5).fillColor(INK_3);
    doc.text(r.bucket, centre - slot / 2, plot.y + plot.h + 5, {
      width: textW(slot),
      align: 'center',
      lineBreak: false,
    });
  });
}

/**
 * The safety statistics sheet: the board a client is shown at a review meeting.
 *
 * Keeps its headline tiles, unlike the manpower report — here the four figures
 * (today's manpower, the cumulative total, safe man-hours and the closure rate)
 * are the point of the document rather than decoration above the charts.
 */
export function renderSafetyPdf(
  r: SafetyPdfReport,
  orgName: string,
  periodName: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const M = 30;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const contentW = pageW - M * 2;

    doc.rect(0, 0, pageW, pageH).fillColor(PAGE).fill();

    // ---- Header ----
    const headH = 72;
    doc.rect(0, 0, pageW, headH).fillColor('#0A131A').fill();
    const titleW = contentW * 0.6;
    doc.font('Helvetica-Bold').fontSize(17).fillColor(INK);
    doc.text(fitText(doc, `${periodName} safety report`, titleW), M, 20, {
      width: titleW,
      lineBreak: false,
    });
    doc.font('Helvetica').fontSize(8).fillColor(INK_3);
    doc.text(
      fitText(doc, [orgName, r.siteName ?? 'All sites'].join(' · ').toUpperCase(), titleW - 10),
      M,
      44,
      { width: titleW, lineBreak: false, characterSpacing: 0.7 },
    );
    drawLogo(doc, pageW - M, 17, 16);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK_2);
    doc.text(r.periodLabel, M + titleW, 44, {
      width: contentW - titleW,
      align: 'right',
      lineBreak: false,
    });
    doc.rect(0, headH, pageW, 1.6).fillColor(ACCENT).fill();

    // ---- Headline tiles ----
    const gap = 12;
    let y = headH + 16;
    const tileH = 58;
    const tileW = (contentW - gap * 3) / 4;
    const perf = r.kpis.safetyPerformance == null ? '—' : `${r.kpis.safetyPerformance}%`;
    const tiles: [string, string, string][] = [
      ["Today's manpower", fmt(r.kpis.dailyManpower), SERIES[0]],
      ['Total manpower as of now', fmt(r.kpis.totalManpower), SERIES[4]],
      ['Total safe man-hours', fmt(r.kpis.totalSafeManHours), SERIES[5]],
      [`Safety performance (target ${r.kpis.safetyPerformanceTarget}%)`, perf, SERIES[3]],
    ];
    tiles.forEach(([label, value, accent], i) => {
      drawKpiTile(doc, M + (tileW + gap) * i, y, tileW, tileH, label, value, accent);
    });
    y += tileH + gap;

    // ---- Trend + observations ----
    const midH = 168;
    const trendW = contentW * 0.62;
    drawMultiLine(
      doc,
      panel(doc, M, y, trendW, midH, 'Trend overview', 'Inductions, toolbox talks and visitors'),
      r.trend.days,
      r.trend.series,
    );
    drawGroupedBars(
      doc,
      panel(
        doc,
        M + trendW + gap,
        y,
        contentW - trendW - gap,
        midH,
        'Safety observations',
        'Raised against closed',
      ),
      r.observations,
    );
    y += midH + gap;

    // ---- Statistics list + category breakup ----
    const lowH = pageH - y - 34;
    const listW = contentW * 0.62;
    const listBox = panel(doc, M, y, listW, lowH, 'Safety statistics', 'Every tracked item');
    drawStatList(doc, listBox, r.statistics);
    drawBars(
      doc,
      panel(
        doc,
        M + listW + gap,
        y,
        contentW - listW - gap,
        lowH,
        'Category-wise breakup',
        'Findings and incidents',
      ),
      r.categoryBreakup.rows.map((b) => ({ name: b.label, count: b.value })),
    );

    doc.font('Helvetica').fontSize(6.5).fillColor(INK_3);
    doc.text(
      `Generated ${new Date().toLocaleString('en-GB', { timeZone: 'UTC' })} UTC · ` +
        `${r.from} to ${r.to} · manpower is labour only; safe man-hours credit ten hours per man-day`,
      M,
      pageH - 24,
      { width: contentW, lineBreak: false },
    );

    doc.end();
  });
}

/** The tracked-item list, in as many columns as the panel affords. */
function drawStatList(
  doc: Doc,
  box: { x: number; y: number; w: number; h: number },
  rows: { label: string; kind: string; value: number }[],
) {
  const { x, y, w, h } = box;
  if (rows.length === 0) return emptyPanel(doc, box, 'Nothing tracked yet');
  const rowH = 13.5;
  const perCol = Math.max(1, Math.floor(h / rowH));
  const cols = Math.max(1, Math.ceil(rows.length / perCol));
  const colW = (w - 10 * (cols - 1)) / cols;
  const valueW = 30;

  rows.forEach((r, i) => {
    const col = Math.floor(i / perCol);
    const rowIdx = i % perCol;
    if (col >= cols) return;
    const cx = x + col * (colW + 10);
    const cy = y + rowIdx * rowH;
    doc.font('Helvetica').fontSize(7).fillColor(INK_2);
    doc.text(fitText(doc, r.label, colW - valueW - 6), cx, cy, {
      width: textW(colW - valueW - 6),
      lineBreak: false,
    });
    doc.font('Helvetica-Bold').fontSize(7).fillColor(INK);
    doc.text(fmt(r.value), cx + colW - valueW, cy, {
      width: textW(valueW),
      align: 'right',
      lineBreak: false,
    });
    doc
      .lineWidth(0.4)
      .strokeColor(GRID)
      .moveTo(cx, cy + rowH - 3.5)
      .lineTo(cx + colW, cy + rowH - 3.5)
      .stroke();
  });
}

/**
 * Renders report rows to a simple landscape-A4 PDF table buffer.
 *
 * `note` is a line under the title — the muster sheet uses it for the legend
 * that explains its blue out times.
 */
export function renderPdf(
  title: string,
  headers: string[],
  rows: Row[],
  note?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 24;
    const usable = doc.page.width - left * 2;
    const colW = usable / headers.length;
    const rowH = 13;
    const bottom = doc.page.height - 28;

    // Logo first, so the title can be clipped short of it on narrow pages.
    const logoW = drawLogo(doc, left + usable, 22, 16);
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(title, left, 24, { width: usable - logoW - 12, ellipsis: true, lineBreak: false });
    let y = 46;

    if (note) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(7)
        .fillColor(NIGHT_INK)
        .text(note, left, y, { width: usable, ellipsis: true, lineBreak: false });
      doc.fillColor('black');
      y += 12;
    }

    const drawRow = (cells: Row, bold: boolean) => {
      if (y + rowH > bottom) {
        doc.addPage();
        y = 28;
      }
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(6.5);
      // The fills go down first, or each one would cover the text already drawn
      // in the cell to its left.
      cells.forEach((cell, i) => {
        if (!isNightTime(cell)) return;
        doc.rect(left + i * colW - 1, y - 2.5, colW, rowH - 1).fill(NIGHT_FILL);
      });
      doc.fillColor('black');
      cells.forEach((cell, i) => {
        doc.text(
          isNightTime(cell) ? cell.value : cell == null ? '' : String(cell),
          left + i * colW,
          y,
          {
            width: colW - 3,
            ellipsis: true,
            lineBreak: false,
          },
        );
      });
      y += rowH;
    };

    drawRow(headers, true);
    for (const row of rows) drawRow(row, false);
    doc.end();
  });
}
