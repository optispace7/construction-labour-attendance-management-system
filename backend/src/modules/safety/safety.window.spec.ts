import { SafetyService } from './safety.service';
import { AppException } from '../../common/errors/app.exception';

/**
 * The custom from–to window, which is the one window the period selector does
 * not derive from an anchor date. The service is built with no dependencies
 * because nothing here touches the database.
 */
const svc = new SafetyService(null as never, null as never);
const window = (from?: string, to?: string) =>
  (
    svc as unknown as { customWindow(f?: string, t?: string): { start: Date; end: Date } }
  ).customWindow(from, to);

const key = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The message a caller actually reads. `Errors.validation` puts it in `meta`
 * and leaves Error.message as the generic title, so asserting on the thrown
 * message alone would pass for any validation failure at all.
 */
function refusal(from?: string, to?: string): string {
  try {
    window(from, to);
  } catch (e) {
    expect(e).toBeInstanceOf(AppException);
    return String((e as AppException).meta?.message ?? '');
  }
  throw new Error('expected the range to be refused');
}

describe('customWindow', () => {
  it('takes the two dates as given, both ends inclusive', () => {
    const { start, end } = window('2026-06-01', '2026-06-30');
    expect(key(start)).toBe('2026-06-01');
    expect(key(end)).toBe('2026-06-30');
  });

  it('allows a single day', () => {
    const { start, end } = window('2026-06-10', '2026-06-10');
    expect(key(start)).toBe('2026-06-10');
    expect(key(end)).toBe('2026-06-10');
  });

  it('refuses a half-given range rather than guessing the other end', () => {
    for (const [f, t] of [
      ['2026-06-01', undefined],
      [undefined, '2026-06-30'],
      [undefined, undefined],
    ] as const) {
      expect(refusal(f, t)).toMatch(/both a from and a to/);
    }
  });

  it('refuses a backwards range', () => {
    expect(refusal('2026-06-30', '2026-06-01')).toMatch(/must not be after/);
  });

  it('refuses anything that is not a date', () => {
    expect(refusal('yesterday', '2026-06-30')).toMatch(/YYYY-MM-DD/);
    expect(refusal('2026-06-01', '30-06-2026')).toMatch(/YYYY-MM-DD/);
    // Shaped like a date, but there is no such day.
    expect(refusal('2026-02-30', '2026-06-30')).toMatch(/not a real date/);
  });

  it('names the end that is wrong', () => {
    expect(refusal('nope', '2026-06-30')).toMatch(/^from /);
    expect(refusal('2026-06-01', 'nope')).toMatch(/^to /);
  });

  it('takes a full year but not a day more', () => {
    // 2026 is not a leap year, so this is 365 days; the cap is 366.
    expect(() => window('2026-01-01', '2026-12-31')).not.toThrow();
    expect(() => window('2026-01-01', '2027-01-01')).not.toThrow();
    expect(refusal('2026-01-01', '2027-01-02')).toMatch(/at most 366 days/);
  });
});
