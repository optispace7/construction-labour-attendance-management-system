import { SafetyMetric } from '@prisma/client';
import {
  AUTOMATED_METRICS,
  METRIC_CATALOG,
  SAFE_MAN_HOURS_PER_DAY,
  isAutomated,
  safetyPerformance,
  safetyWindow,
  specFor,
} from './safety.metrics';

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const key = (d: Date) => d.toISOString().slice(0, 10);

describe('metric catalogue', () => {
  it('covers every metric the schema knows about', () => {
    // A metric in the enum but not the catalogue would be invisible on the form
    // and unfillable — the form is driven entirely by this list.
    const catalogued = new Set(METRIC_CATALOG.map((m) => m.metric));
    const missing = Object.values(SafetyMetric).filter((m) => !catalogued.has(m));
    expect(missing).toEqual([]);
  });

  it('lists no metric twice', () => {
    const seen = METRIC_CATALOG.map((m) => m.metric);
    expect(seen.length).toBe(new Set(seen).size);
  });

  it('marks exactly the three attendance-derived metrics as automated', () => {
    expect(AUTOMATED_METRICS.sort()).toEqual(
      ['DAILY_MANPOWER', 'TOTAL_MANPOWER', 'TOTAL_SAFE_MAN_HOURS'].sort(),
    );
    expect(isAutomated('TOOLBOX_TALK')).toBe(false);
    expect(isAutomated('TOTAL_SAFE_MAN_HOURS')).toBe(true);
  });

  it('gives every metric a label', () => {
    for (const m of Object.values(SafetyMetric)) {
      expect(specFor(m)?.label ?? '').not.toBe('');
    }
  });

  it('credits ten hours per man-day, as the client specified', () => {
    expect(SAFE_MAN_HOURS_PER_DAY).toBe(10);
  });
});

describe('safetyWindow', () => {
  it('daily is the one day', () => {
    const { start, end } = safetyWindow('daily', day('2026-07-29'));
    expect([key(start), key(end)]).toEqual(['2026-07-29', '2026-07-29']);
  });

  it('weekly is the Monday-to-Sunday week containing the date', () => {
    // 2026-07-29 is a Wednesday.
    const { start, end } = safetyWindow('weekly', day('2026-07-29'));
    expect([key(start), key(end)]).toEqual(['2026-07-27', '2026-08-02']);
  });

  it('keeps a Sunday in the week that is ending, not the one starting', () => {
    // The off-by-one that a plain getUTCDay would introduce.
    const { start, end } = safetyWindow('weekly', day('2026-08-02'));
    expect([key(start), key(end)]).toEqual(['2026-07-27', '2026-08-02']);
  });

  it('weekly on a Monday starts that same day', () => {
    const { start } = safetyWindow('weekly', day('2026-07-27'));
    expect(key(start)).toBe('2026-07-27');
  });

  it('monthly runs the whole calendar month', () => {
    const { start, end } = safetyWindow('monthly', day('2026-07-29'));
    expect([key(start), key(end)]).toEqual(['2026-07-01', '2026-07-31']);
  });

  it('gets February right in a leap year', () => {
    const { start, end } = safetyWindow('monthly', day('2028-02-10'));
    expect([key(start), key(end)]).toEqual(['2028-02-01', '2028-02-29']);
  });

  it('gets February right in a common year', () => {
    const { start, end } = safetyWindow('monthly', day('2026-02-10'));
    expect([key(start), key(end)]).toEqual(['2026-02-01', '2026-02-28']);
  });
});

describe('safetyPerformance', () => {
  it('is the share of raised findings that were closed', () => {
    expect(
      safetyPerformance({
        UNSAFE_ACTS: 10,
        UNSAFE_CONDITIONS: 6,
        SAFETY_OBSERVATION: 4,
        UNSAFE_ACTS_CLOSED: 9,
        UNSAFE_CONDITIONS_CLOSED: 5,
        SAFETY_OBSERVATION_CLOSED: 4,
      }),
    ).toBe(90);
  });

  it('is null when nothing was raised at all', () => {
    // A site with no findings has no closure rate. Printing 100% would read as
    // a score rather than an absence of data.
    expect(safetyPerformance({})).toBeNull();
    expect(safetyPerformance({ UNSAFE_ACTS_CLOSED: 3 })).toBeNull();
  });

  it("caps at 100 when yesterday's findings close today", () => {
    expect(safetyPerformance({ UNSAFE_ACTS: 2, UNSAFE_ACTS_CLOSED: 9 })).toBe(100);
  });

  it('is 0 when everything raised is still open', () => {
    expect(safetyPerformance({ UNSAFE_ACTS: 5 })).toBe(0);
  });
});
