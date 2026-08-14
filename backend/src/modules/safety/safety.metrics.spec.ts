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
  /** A month with all four routine activities done, so only the case under test bites. */
  const active = {
    TOOLBOX_TALK: 20,
    TRAINING: 4,
    WORK_PERMIT: 12,
    LABOUR_INDUCTION: 6,
  };

  it('opens a month with nothing recorded at 100', () => {
    // Not 96: on the first of the month no toolbox talk has been missed, it
    // simply has not happened yet.
    const { score, deductions } = safetyPerformance({});
    expect(score).toBe(100);
    expect(deductions).toEqual([]);
  });

  it('leaves a fully kept month with no findings at 100', () => {
    expect(safetyPerformance(active).score).toBe(100);
  });

  it('takes 5 off per medical treatment case', () => {
    expect(safetyPerformance({ ...active, MEDICAL_TREATMENT_CASE: 2 }).score).toBe(90);
  });

  it('takes 10 off per lost time injury', () => {
    expect(safetyPerformance({ ...active, LOST_TIME_INJURY: 2 }).score).toBe(80);
  });

  it('costs nothing when everything raised was closed', () => {
    expect(safetyPerformance({ ...active, UNSAFE_ACTS: 10, UNSAFE_ACTS_CLOSED: 10 }).score).toBe(
      100,
    );
  });

  it('costs a point per finding left open', () => {
    // The client's own worked example: 12 raised against 10 closed is −2.
    expect(safetyPerformance({ ...active, UNSAFE_ACTS: 12, UNSAFE_ACTS_CLOSED: 10 }).score).toBe(
      98,
    );
  });

  it('scores each raised/closed pair on its own', () => {
    // Over-closing unsafe acts must not cover the two observations nobody
    // went back to.
    const { score } = safetyPerformance({
      ...active,
      UNSAFE_ACTS: 2,
      UNSAFE_ACTS_CLOSED: 9,
      SAFETY_OBSERVATION: 5,
      SAFETY_OBSERVATION_CLOSED: 3,
    });
    expect(score).toBe(98);
  });

  it('takes one point per routine activity the month never recorded', () => {
    // Once for the month, not once per day: a per-day rule would reach −78 and
    // leave a month with a lost time injury scoring better than a quiet one.
    const { score } = safetyPerformance({ TOOLBOX_TALK: 20 });
    expect(score).toBe(97);
  });

  it('floors at 0 rather than going negative', () => {
    expect(safetyPerformance({ ...active, LOST_TIME_INJURY: 20 }).score).toBe(0);
  });

  it('shows its working, heaviest deduction first', () => {
    const { score, deductions } = safetyPerformance({
      ...active,
      LOST_TIME_INJURY: 1,
      MEDICAL_TREATMENT_CASE: 1,
      UNSAFE_CONDITIONS: 4,
      UNSAFE_CONDITIONS_CLOSED: 3,
    });
    expect(score).toBe(84);
    expect(deductions.map((d) => d.points)).toEqual([10, 5, 1]);
    expect(deductions[0].label).toBe('Lost time injury');
    expect(deductions[2].detail).toBe('4 raised, 3 closed');
  });
});
