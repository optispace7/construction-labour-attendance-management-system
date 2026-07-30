import { SafetyMetric } from '@prisma/client';

/**
 * The safety board's metric catalogue: what each one is called, whether it is
 * typed in or derived, and what it is grouped under.
 *
 * This is the single source of truth for the daily form. Both the admin page and
 * the mobile screen render whatever this returns rather than keeping their own
 * copies of twenty-one labels — a metric added here appears in both without a
 * frontend change, and no two clients can disagree about what "TBT" is called.
 */
export type MetricKind = 'AUTOMATED' | 'MANUAL';

export interface MetricSpec {
  metric: SafetyMetric;
  label: string;
  kind: MetricKind;
  /** Grouping for the form, so twenty-one fields do not arrive as one wall. */
  group: 'Manpower' | 'Induction & training' | 'Observations' | 'Incidents' | 'Compliance';
}

/**
 * Hours credited per man-day when accumulating safe man-hours.
 *
 * A flat shift length rather than clocked minutes, because this is the figure
 * that goes on the board at the gate and it has to be reproducible by hand from
 * the man-day count. Chosen by the client.
 */
export const SAFE_MAN_HOURS_PER_DAY = 10;

/** The safety-performance percentage a site is expected to hold. */
export const SAFETY_PERFORMANCE_TARGET = 90;

export const METRIC_CATALOG: MetricSpec[] = [
  // Derived from attendance — never typed in, but each can still carry a note.
  { metric: 'DAILY_MANPOWER', label: 'Daily manpower', kind: 'AUTOMATED', group: 'Manpower' },
  { metric: 'TOTAL_MANPOWER', label: 'Total manpower', kind: 'AUTOMATED', group: 'Manpower' },
  {
    metric: 'TOTAL_SAFE_MAN_HOURS',
    label: 'Total safe man-hours',
    kind: 'AUTOMATED',
    group: 'Manpower',
  },

  {
    metric: 'LABOUR_INDUCTION',
    label: 'Labour induction',
    kind: 'MANUAL',
    group: 'Induction & training',
  },
  {
    metric: 'TOOLBOX_TALK',
    label: 'Toolbox talk (TBT)',
    kind: 'MANUAL',
    group: 'Induction & training',
  },
  {
    metric: 'VISITOR_INDUCTION',
    label: 'Visitor induction',
    kind: 'MANUAL',
    group: 'Induction & training',
  },
  { metric: 'TRAINING', label: 'Training', kind: 'MANUAL', group: 'Induction & training' },

  { metric: 'UNSAFE_ACTS', label: 'Unsafe acts', kind: 'MANUAL', group: 'Observations' },
  {
    metric: 'UNSAFE_ACTS_CLOSED',
    label: 'Unsafe acts closed',
    kind: 'MANUAL',
    group: 'Observations',
  },
  {
    metric: 'UNSAFE_CONDITIONS',
    label: 'Unsafe conditions',
    kind: 'MANUAL',
    group: 'Observations',
  },
  {
    metric: 'UNSAFE_CONDITIONS_CLOSED',
    label: 'Unsafe conditions closed',
    kind: 'MANUAL',
    group: 'Observations',
  },
  {
    metric: 'SAFETY_OBSERVATION',
    label: 'Safety observation',
    kind: 'MANUAL',
    group: 'Observations',
  },
  {
    metric: 'SAFETY_OBSERVATION_CLOSED',
    label: 'Safety observation closed',
    kind: 'MANUAL',
    group: 'Observations',
  },

  { metric: 'NEAR_MISS', label: 'Near miss', kind: 'MANUAL', group: 'Incidents' },
  { metric: 'FIRST_AID', label: 'First aid', kind: 'MANUAL', group: 'Incidents' },
  {
    metric: 'MEDICAL_TREATMENT_CASE',
    label: 'Medical treatment case',
    kind: 'MANUAL',
    group: 'Incidents',
  },
  { metric: 'LOST_TIME_INJURY', label: 'Lost time injury', kind: 'MANUAL', group: 'Incidents' },

  { metric: 'WORK_PERMIT', label: 'Work permit', kind: 'MANUAL', group: 'Compliance' },
  { metric: 'SAFETY_INSPECTION', label: 'Safety inspections', kind: 'MANUAL', group: 'Compliance' },
  { metric: 'SAFETY_AUDIT', label: 'Safety audit', kind: 'MANUAL', group: 'Compliance' },
  { metric: 'WASTE_DISPOSAL', label: 'Waste disposal', kind: 'MANUAL', group: 'Compliance' },
];

const BY_METRIC = new Map(METRIC_CATALOG.map((m) => [m.metric, m]));

export const specFor = (m: SafetyMetric): MetricSpec | undefined => BY_METRIC.get(m);

export const AUTOMATED_METRICS = METRIC_CATALOG.filter((m) => m.kind === 'AUTOMATED').map(
  (m) => m.metric,
);

export const isAutomated = (m: SafetyMetric): boolean =>
  (AUTOMATED_METRICS as SafetyMetric[]).includes(m);

export type SafetyPeriodName = 'daily' | 'weekly' | 'monthly';

/**
 * The window a period selector means, anchored on one picked date.
 *
 * Weekly is the calendar week (Monday–Sunday) containing that date and monthly
 * the calendar month, so the labels "this week" and "this month" are literally
 * true rather than quietly meaning "the last seven days". Both ends are
 * inclusive, which is what the queries filter on.
 */
export function safetyWindow(period: SafetyPeriodName, date: Date): { start: Date; end: Date } {
  const DAY = 86_400_000;
  if (period === 'daily') return { start: date, end: date };
  if (period === 'weekly') {
    // getUTCDay is 0 on Sunday; shift so Monday opens the week.
    const dow = (date.getUTCDay() + 6) % 7;
    const start = new Date(date.getTime() - dow * DAY);
    return { start, end: new Date(start.getTime() + 6 * DAY) };
  }
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  // Day 0 of the next month is the last day of this one, leap years included.
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 0)) };
}

/**
 * Safety performance: the share of everything raised that has been closed.
 *
 * Unsafe acts, unsafe conditions and safety observations all have a matching
 * "closed" count, so the three pair up into one closure rate. Returns null when
 * nothing was raised at all — a site with no findings has no closure rate, and
 * printing 100% there would read as a score rather than an absence.
 *
 * Capped at 100: closing more items than were raised in the same window is
 * normal (yesterday's findings close today) but a figure above 100% on a
 * performance dial reads as a bug.
 */
export function safetyPerformance(totals: Partial<Record<SafetyMetric, number>>): number | null {
  const n = (m: SafetyMetric) => totals[m] ?? 0;
  const raised = n('UNSAFE_ACTS') + n('UNSAFE_CONDITIONS') + n('SAFETY_OBSERVATION');
  const closed =
    n('UNSAFE_ACTS_CLOSED') + n('UNSAFE_CONDITIONS_CLOSED') + n('SAFETY_OBSERVATION_CLOSED');
  if (raised === 0) return null;
  return Math.min(100, Math.round((closed / raised) * 100));
}
