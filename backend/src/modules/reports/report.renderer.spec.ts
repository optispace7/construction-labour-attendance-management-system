import * as fs from 'fs';
import * as zlib from 'node:zlib';
import * as ExcelJS from 'exceljs';
import {
  ATT_SHEET_LEGEND,
  ManpowerReport,
  renderAttendanceSheetXlsx,
  renderManpowerPdf,
  renderPdf,
} from './report.renderer';

/**
 * The text of a PDF's content streams. PDFKit deflates them, so each candidate
 * chunk is inflated and the ones that are not streams are skipped.
 */
function pdfContent(buf: Buffer): string {
  const parts: string[] = [];
  const text = buf.toString('latin1');
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      parts.push(
        zlib.inflateSync(Buffer.from(text.slice(start, end), 'latin1')).toString('latin1'),
      );
    } catch {
      /* not a deflated stream — an image or font file */
    }
  }
  return parts.join('\n');
}

/** The visible text of a PDF — PDFKit writes each run as a hex string. */
function pdfText(buf: Buffer): string {
  return (pdfContent(buf).match(/<([0-9a-f]+)>/g) ?? [])
    .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'))
    .join('\n');
}

function sample(overrides: Partial<ManpowerReport> = {}): ManpowerReport {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    days.push(new Date(Date.UTC(2026, 6, 20) - i * 86_400_000).toISOString().slice(0, 10));
  }
  return {
    reportType: 'DAILY',
    periodLabel: '20 Jul 2026',
    days,
    trend: [112, 118, 118, 125, 110, 118, 110],
    periodFrom: days[6],
    totalManDays: 118,
    uniqueWorkers: 116,
    manHours: 944,
    activeTrades: 8,
    avgPerDay: 118,
    peak: 125,
    byTrade: [
      { name: 'Masons', count: 35 },
      { name: 'Carpenters', count: 22 },
      { name: 'Electricians', count: 18 },
      { name: 'Plumbers', count: 17 },
      { name: 'General Labors', count: 12 },
      { name: 'Riggers', count: 8 },
      { name: 'Crane Operators', count: 8 },
    ],
    byVendor: [
      { name: 'BuildRight Contractors', count: 41 },
      { name: 'Prime Electric', count: 24 },
      { name: 'Apex Plumbing', count: 18 },
      { name: 'HSM Steel', count: 12 },
      { name: 'City Labors', count: 12 },
      { name: 'Crane Services', count: 11 },
    ],
    ...overrides,
  };
}

describe('renderAttendanceSheetXlsx', () => {
  const months = [{ label: 'August 2026', days: [5, 6] }];
  const infoHeaders = ['SL No', 'Workers Name', 'EMP - ID NO'];
  const night = (value: string, day?: string) => ({ value, day, night: true as const });
  const rows = [
    // A day man, then a night man whose out time carries to the next morning.
    { info: [1, 'Ankesh Kumar', 'W-0017'], cells: ['11:06', '19:14', '11:02', '18:58'] },
    {
      info: [2, 'Kailu Pasvan', 'W-0084'],
      cells: [night('20:20'), night('07:52', '06 Aug'), night('20:14'), night('08:01', '07 Aug')],
      night: true,
    },
  ];

  it('puts the legend above the grid and leaves the headers and data below it', async () => {
    const buf = await renderAttendanceSheetXlsx(months, infoHeaders, rows);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Attendance')!;

    // Row 1 explains the colour; the four header rows follow; data starts at 6.
    expect(ws.getCell(1, 1).value).toBe(ATT_SHEET_LEGEND);
    expect(ws.getCell(2, 1).value).toBe('SL No');
    expect(ws.getCell(2, infoHeaders.length + 1).value).toBe('August 2026');
    expect(ws.getCell(4, infoHeaders.length + 1).value).toBe(5);
    expect(ws.getCell(5, infoHeaders.length + 1).value).toBe('IN');
    expect(ws.getCell(5, infoHeaders.length + 2).value).toBe('Out');
    expect(ws.getCell(6, 2).value).toBe('Ankesh Kumar');
    expect(ws.getCell(6, infoHeaders.length + 2).value).toBe('19:14');
    // Frozen below the headers, so scrolling a month keeps them in view.
    expect(ws.views[0]).toMatchObject({ xSplit: infoHeaders.length, ySplit: 5 });
  });

  it('fills a night-shift row end to end, leaving the text alone', async () => {
    const buf = await renderAttendanceSheetXlsx(months, infoHeaders, rows);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Attendance')!;
    const filled = (c: ExcelJS.Cell) =>
      (c.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb ?? null;

    const nightIn = ws.getCell(7, infoHeaders.length + 1);
    const nightOut = ws.getCell(7, infoHeaders.length + 2);
    // The clock times alone — the filled cell is what says it is a night shift.
    expect([nightIn.value, nightOut.value]).toEqual(['20:20', '07:52']);
    expect(filled(nightIn)).toBe('FFDCE9F7');
    expect(filled(nightOut)).toBe('FFDCE9F7');
    // The text itself is untouched, so it stays black on the fill.
    expect((nightOut.font as ExcelJS.Font | undefined)?.color?.argb).toBeUndefined();

    // The band runs from the serial number across every column of the row…
    const wholeRow = Array.from({ length: infoHeaders.length + 4 }, (_, i) =>
      filled(ws.getCell(7, i + 1)),
    );
    expect(wholeRow).toEqual(Array(infoHeaders.length + 4).fill('FFDCE9F7'));
    // …and the serial number is still a number, not text.
    expect(ws.getCell(7, 1).value).toBe(2);

    // A day man's row is untouched throughout.
    expect(filled(ws.getCell(6, 1))).toBeNull();
    expect(filled(ws.getCell(6, infoHeaders.length + 2))).toBeNull();
  });
});

describe('renderPdf', () => {
  it('fills the cells of a night shift and leaves the text black', async () => {
    const buf = await renderPdf(
      'Attendance sheet',
      ['Workers Name', '5 Aug IN', '5 Aug Out'],
      [
        ['Ankesh Kumar', '11:06', '19:14'],
        [
          'Kailu Pasvan',
          { value: '20:20', night: true },
          { value: '07:52', day: '06 Aug', night: true },
        ],
      ],
      ATT_SHEET_LEGEND,
    );
    const content = pdfContent(buf);
    const text = pdfText(buf);

    // #DCE9F7 as PDFKit writes a DeviceRGB fill: "0.8627… 0.9137… 0.9686… scn",
    // and `re f` is the rectangle it paints behind the cell.
    expect(content).toMatch(
      /[\d.]+ [\d.]+ [\d.]+ [\d.]+ re\n\/DeviceRGB cs\n0\.8627\d* 0\.9137\d* 0\.9686\d* scn\nf/,
    );
    // The clock time alone reaches the page — no marker was appended.
    expect(text).toContain('07:52');
    expect(text).not.toContain('+1');
    // The ink goes back to black for the text, which sits on top of the fill.
    expect(content).toMatch(/\b0 0 0 scn/);
  });

  it('needs no fill when nothing runs overnight', async () => {
    const buf = await renderPdf(
      'Attendance sheet',
      ['Workers Name', 'IN', 'Out'],
      [['Ankesh Kumar', '11:06', '19:14']],
    );
    expect(pdfContent(buf)).not.toMatch(/0\.8627\d* 0\.9137\d* 0\.9686\d* scn/);
  });
});

describe('renderManpowerPdf', () => {
  it('renders a non-trivial PDF', async () => {
    const buf = await renderManpowerPdf(sample(), 'Sunrise Constructions Pvt Ltd');
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(2000);
    if (process.env.MANPOWER_PDF_OUT) fs.writeFileSync(process.env.MANPOWER_PDF_OUT, buf);
  });

  it('survives an empty period without throwing', async () => {
    const buf = await renderManpowerPdf(
      sample({
        trend: [0, 0, 0, 0, 0, 0, 0],
        totalManDays: 0,
        uniqueWorkers: 0,
        manHours: 0,
        activeTrades: 0,
        avgPerDay: 0,
        peak: 0,
        byTrade: [],
        byVendor: [],
      }),
      'Sunrise Constructions Pvt Ltd',
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('handles a month-long period and many trades', async () => {
    const days: string[] = [];
    const trend: number[] = [];
    for (let i = 0; i < 31; i++) {
      days.push(new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10));
      trend.push(80 + ((i * 7) % 45));
    }
    const buf = await renderManpowerPdf(
      sample({
        reportType: 'MONTHLY',
        periodLabel: 'June 2026',
        days,
        trend,
        byTrade: Array.from({ length: 14 }, (_, i) => ({
          name: `Trade with a rather long name ${i}`,
          count: 40 - i * 2,
        })),
        byVendor: Array.from({ length: 12 }, (_, i) => ({
          name: `Vendor ${i}`,
          count: 30 - i * 2,
        })),
      }),
      'Sunrise Constructions Pvt Ltd',
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
