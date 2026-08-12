import { describe, expect, it } from 'vitest';
import { sheetHeight, SheetOptions } from './manpowerSheet';

/**
 * The canvas is sized from this calculation before a single pixel is drawn, so
 * an error here does not look like a layout bug — it silently crops the bottom
 * of the sheet off, and the total row is the last thing on it.
 */

const base: SheetOptions = {
  audience: 'client',
  companyName: 'Optispace Infra Pvt Ltd',
  siteName: 'IndraNagar 01 Site',
  dateLabel: 'Tue, 12 Aug 2026',
  byDesignation: [
    { name: 'Mason', count: 42 },
    { name: 'Electrician', count: 18 },
    { name: 'Helper', count: 55 },
  ],
  byVendor: [
    { name: 'Sri Balaji Contractors', count: 74 },
    { name: 'Everest Manpower', count: 41 },
  ],
};

describe('sheetHeight', () => {
  it('grows by one row height per designation', () => {
    const three = sheetHeight(base);
    const four = sheetHeight({
      ...base,
      byDesignation: [...base.byDesignation, { name: 'Carpenter', count: 13 }],
    });
    expect(four - three).toBe(42);
  });

  it('makes room for the vendor table only on the internal sheet', () => {
    const client = sheetHeight(base);
    const internal = sheetHeight({ ...base, audience: 'internal' });
    // Gap + header + two rows + total.
    expect(internal - client).toBe(22 + 40 + 2 * 42 + 44);
  });

  it('ignores the vendor rows on the client sheet', () => {
    const withVendors = sheetHeight(base);
    const without = sheetHeight({ ...base, byVendor: [] });
    expect(withVendors).toBe(without);
  });

  it('still leaves room for the empty-state line when nobody logged in', () => {
    const empty = sheetHeight({ ...base, byDesignation: [] });
    // The "nobody logged in" strip is a row's worth of space, so the sheet
    // never collapses onto its own total.
    expect(empty).toBeGreaterThan(200);
  });

  it('drops the letterhead band when there is no company name or logo', () => {
    const branded = sheetHeight(base);
    const plain = sheetHeight({ ...base, companyName: '   ', logo: null });
    expect(branded - plain).toBe(48 + 20);
  });
});
