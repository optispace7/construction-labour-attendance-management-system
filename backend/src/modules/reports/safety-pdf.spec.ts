import { renderSafetyPdf, SafetyPdfReport } from './report.renderer';

/**
 * The safety sheet is a one-page export, and it is laid out by hand: fixed
 * boxes filled top to bottom rather than a flow that would reflow onto page
 * two. Adding the waste breakdown put a fourth panel on the lower half, so this
 * pins the thing that would actually break — a second page appearing, or the
 * render throwing on an empty panel — rather than the pixels.
 */

const days = Array.from({ length: 30 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
const line = (n: number) => Array.from({ length: 30 }, (_, i) => (i * 7 + n) % 9);

const report = (over: Partial<SafetyPdfReport> = {}): SafetyPdfReport => ({
  periodLabel: '01 Aug 2026 — 30 Aug 2026',
  from: '2026-08-01',
  to: '2026-08-30',
  siteName: 'Tower A',
  kpis: {
    periodManpower: 3120,
    totalManpower: 41230,
    periodSafeManHours: 31200,
    safetyPerformance: 84,
    safetyPerformanceTarget: 90,
  },
  safetyPerformanceDeductions: [
    { label: 'Lost time injury', points: 10, detail: '1 × 10 points' },
    { label: 'Unsafe acts left open', points: 4, detail: '12 raised, 8 closed' },
  ],
  trend: {
    days,
    series: [
      { label: 'Labour induction', values: line(1) },
      { label: 'Toolbox talk (TBT)', values: line(3) },
      { label: 'Visitor induction', values: line(5) },
    ],
  },
  observations: [
    { bucket: 'Daily', raised: 3, closed: 2 },
    { bucket: 'Weekly', raised: 18, closed: 14 },
    { bucket: 'Monthly', raised: 71, closed: 60 },
  ],
  statistics: [
    { label: 'Manpower', kind: 'AUTOMATED', value: 3120 },
    { label: 'Safe man-hours', kind: 'AUTOMATED', value: 31200 },
    { label: 'Toolbox talk (TBT)', kind: 'MANUAL', value: 26 },
    { label: 'Waste disposal', kind: 'MANUAL', value: 137 },
  ],
  categoryBreakup: {
    rows: [
      { label: 'Unsafe acts', value: 12, percent: 46 },
      { label: 'Unsafe conditions', value: 9, percent: 35 },
      { label: 'Near misses', value: 4, percent: 15 },
      { label: 'Lost time injuries', value: 1, percent: 4 },
    ],
  },
  wasteBreakup: {
    rows: [
      { label: 'Civil / Block Waste', value: 48, percent: 35 },
      { label: 'Gypsum Waste', value: 30, percent: 22 },
      { label: 'Wooden Waste', value: 22, percent: 16 },
      { label: 'Paper Waste', value: 15, percent: 11 },
      { label: 'Scrap / Metal Waste', value: 12, percent: 9 },
      { label: 'Hazardous Waste', value: 6, percent: 4 },
      { label: 'Electrical / E-Waste', value: 3, percent: 2 },
      { label: 'Food Waste', value: 1, percent: 1 },
    ],
  },
  ...over,
});

const pageCount = (buf: Buffer) =>
  buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;

describe('the safety sheet as a PDF', () => {
  it('stays on one page with the waste breakdown on it', async () => {
    const buf = await renderSafetyPdf(report(), 'Optispace Infra Pvt. Ltd.', 'Monthly');

    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(buf)).toBe(1);
  });

  it('renders a period with no waste recorded rather than throwing', async () => {
    // An empty breakdown draws the panel's empty state; it used to be a shape
    // the layout had never been handed.
    const buf = await renderSafetyPdf(
      report({ wasteBreakup: { rows: [] } }),
      'Optispace Infra Pvt. Ltd.',
      'Daily',
    );

    expect(pageCount(buf)).toBe(1);
  });
});
