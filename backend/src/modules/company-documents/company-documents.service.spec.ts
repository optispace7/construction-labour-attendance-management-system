import { DateTime, Settings } from 'luxon';
import { daysUntil, formatDay, parseDay } from './company-documents.service';

describe('company document dates', () => {
  const realNow = Settings.now;
  afterEach(() => {
    Settings.now = realNow;
  });

  /** Freeze "now" at an instant, so the countdown is testable. */
  const freeze = (iso: string) => {
    const t = DateTime.fromISO(iso, { zone: 'utc' }).toMillis();
    Settings.now = () => t;
  };

  it('round-trips a validity date through the DATE column unchanged', () => {
    expect(formatDay(parseDay('2026-12-31'))).toBe('2026-12-31');
  });

  it('counts whole days to the validity date', () => {
    freeze('2026-08-12T06:00:00Z'); // 11:30 IST on the 12th
    expect(daysUntil(parseDay('2026-08-22'), 'Asia/Kolkata')).toBe(10);
    expect(daysUntil(parseDay('2026-08-13'), 'Asia/Kolkata')).toBe(1);
    expect(daysUntil(parseDay('2026-08-12'), 'Asia/Kolkata')).toBe(0);
  });

  it('reports an expired document as a negative count', () => {
    freeze('2026-08-12T06:00:00Z');
    expect(daysUntil(parseDay('2026-08-11'), 'Asia/Kolkata')).toBe(-1);
    expect(daysUntil(parseDay('2026-07-13'), 'Asia/Kolkata')).toBe(-30);
  });

  /**
   * The bug this guards: 18:30 UTC is already the next day in India, so a
   * validity of "tomorrow IST" must not still read as two days out — and a
   * document expiring today must not read as expired.
   */
  it('measures the countdown in the company timezone, not the server clock', () => {
    freeze('2026-08-12T20:00:00Z'); // 01:30 IST on the 13th
    expect(daysUntil(parseDay('2026-08-13'), 'Asia/Kolkata')).toBe(0);
    expect(daysUntil(parseDay('2026-08-14'), 'Asia/Kolkata')).toBe(1);
    expect(daysUntil(parseDay('2026-08-12'), 'Asia/Kolkata')).toBe(-1);
  });

  it('leaves an undated document without a countdown', () => {
    expect(formatDay(null)).toBeNull();
  });

  it('rejects a date it cannot parse', () => {
    expect(() => parseDay('31-12-2026')).toThrow();
  });
});
