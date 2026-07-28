import { MANPOWER_MAX_DAYS, resolveManpowerRange, vendorGroupLabel } from './attendance.service';

describe('vendorGroupLabel', () => {
  it('uses the contractor name when there is one', () => {
    expect(vendorGroupLabel({ vendor: { name: 'Nivishka Services' }, category: 'WORKER' })).toBe(
      'Nivishka Services',
    );
  });

  it('files company staff under Staff, not "No vendor"', () => {
    // Staff are on the payroll directly. Showing them as an unnamed contractor
    // made correct data look like a gap in the records.
    expect(vendorGroupLabel({ vendor: null, category: 'STAFF' })).toBe('Staff');
  });

  it('files visitors under Visitors', () => {
    expect(vendorGroupLabel({ vendor: null, category: 'VISITOR' })).toBe('Visitors');
  });

  it('still says "No vendor" for a labourer who really is missing one', () => {
    // A genuine data gap, and it must keep saying so rather than being tidied
    // into a label that hides it.
    expect(vendorGroupLabel({ vendor: null, category: 'WORKER' })).toBe('No vendor');
  });

  it('treats a blank contractor name as no contractor at all', () => {
    expect(vendorGroupLabel({ vendor: { name: '   ' }, category: 'STAFF' })).toBe('Staff');
  });
});

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const key = (d: Date) => d.toISOString().slice(0, 10);
const today = day('2026-07-20');

describe('resolveManpowerRange', () => {
  it('defaults to the seven days ending today', () => {
    const { start, end } = resolveManpowerRange(undefined, undefined, today);
    expect(key(start)).toBe('2026-07-14');
    expect(key(end)).toBe('2026-07-20');
  });

  it('honours an explicit window', () => {
    const { start, end } = resolveManpowerRange('2026-07-06', '2026-07-12', today);
    expect(key(start)).toBe('2026-07-06');
    expect(key(end)).toBe('2026-07-12');
  });

  it('treats a lone "from" as the seven days starting there', () => {
    // Only `to` is missing, so the end stays today and `from` is respected.
    const { start, end } = resolveManpowerRange('2026-07-01', undefined, today);
    expect(key(start)).toBe('2026-07-01');
    expect(key(end)).toBe('2026-07-20');
  });

  it('swaps an inverted range rather than returning nothing', () => {
    const { start, end } = resolveManpowerRange('2026-07-12', '2026-07-06', today);
    expect(key(start)).toBe('2026-07-06');
    expect(key(end)).toBe('2026-07-12');
  });

  it('caps an over-long span, keeping the requested end', () => {
    const { start, end } = resolveManpowerRange('2020-01-01', '2026-07-20', today);
    expect(key(end)).toBe('2026-07-20');
    const span = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    expect(span).toBe(MANPOWER_MAX_DAYS);
  });

  it('ignores malformed input instead of producing an invalid window', () => {
    const { start, end } = resolveManpowerRange('last-tuesday', 'nope', today);
    expect(key(start)).toBe('2026-07-14');
    expect(key(end)).toBe('2026-07-20');
  });
});
