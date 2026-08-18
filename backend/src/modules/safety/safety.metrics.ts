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

/**
 * The metric whose figure is a sum of a breakdown rather than something typed.
 *
 * WASTE_DISPOSAL still holds one number, and every total, chart and export goes
 * on reading it from there — but the number is now the total of that day's
 * waste rows, so nothing can type a figure that disagrees with its own detail.
 */
export const WASTE_METRIC: SafetyMetric = 'WASTE_DISPOSAL';

/**
 * What a new organization's waste dropdown starts with — the eight streams the
 * client named. A starting point, not a fixed list: the types are rows, and the
 * sheet can add, rename and retire them without a release.
 */
export const DEFAULT_WASTE_TYPES = [
  'Civil / Block Waste',
  'Gypsum Waste',
  'Wooden Waste',
  'Paper Waste',
  'Scrap / Metal Waste',
  'Hazardous Waste',
  'Electrical / E-Waste',
  'Food Waste',
] as const;

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
 * Points taken off the month for each thing that went wrong. Chosen by the
 * client; kept in one object so the weights can be retuned without hunting
 * through the scoring function.
 */
export const SAFETY_SCORE_WEIGHTS = {
  /** Per medical treatment case. */
  medicalTreatmentCase: 5,
  /** Per lost time injury. */
  lostTimeInjury: 10,
  /** Once for the whole month, per metric, when the month recorded none of it. */
  inactiveMetric: 1,
  /** Per finding raised in the month and not closed within it. */
  openFinding: 1,
} as const;

/**
 * The routine safety work a month is expected to show at least some of.
 *
 * Scored once for the month rather than once per day: a per-day penalty over a
 * 26-day month reaches −78 across these four, which would leave a month with a
 * lost time injury scoring better than one with thin paperwork.
 */
export const ACTIVITY_METRICS: SafetyMetric[] = [
  'TOOLBOX_TALK',
  'TRAINING',
  'WORK_PERMIT',
  'LABOUR_INDUCTION',
];

/**
 * Findings and their matching closure counts.
 *
 * Scored pair by pair, so closing more unsafe acts than were raised cannot
 * quietly cover for observations nobody went back to.
 */
export const FINDING_PAIRS: [raised: SafetyMetric, closed: SafetyMetric][] = [
  ['UNSAFE_ACTS', 'UNSAFE_ACTS_CLOSED'],
  ['UNSAFE_CONDITIONS', 'UNSAFE_CONDITIONS_CLOSED'],
  ['SAFETY_OBSERVATION', 'SAFETY_OBSERVATION_CLOSED'],
];

/** One line of the score's working, for the card that explains the number. */
export interface SafetyScoreLine {
  label: string;
  /** Always positive — the amount taken off. */
  points: number;
  /** How the deduction was arrived at, e.g. "12 raised, 10 closed". */
  detail: string;
}

export interface SafetyScore {
  /** 0–100. */
  score: number;
  /** Every deduction applied, largest first. Empty means a clean month. */
  deductions: SafetyScoreLine[];
}

/**
 * Safety performance: a month opens at 100 and loses points for what goes wrong.
 *
 * Incidents cost the most, routine work that never happened costs a point each,
 * and every finding left open at the end of the month costs a point. Floored at
 * 0 — a month bad enough to go negative is already telling the whole story at
 * zero, and a negative percentage on a dial reads as a bug.
 *
 * A month with nothing recorded at all scores 100 rather than 96: on the first
 * of the month no toolbox talk has been missed yet, it simply has not happened.
 * Once anything is entered the month is being kept, and the inactivity
 * deductions apply in full.
 *
 * Note the deliberate trade the client accepted: raising a finding and not
 * closing it costs a point, so the score is not neutral to how much a site
 * reports. Closing what you raise is what protects it.
 */
export function safetyPerformance(totals: Partial<Record<SafetyMetric, number>>): SafetyScore {
  const n = (m: SafetyMetric) => totals[m] ?? 0;
  const deductions: SafetyScoreLine[] = [];

  const incidents: [SafetyMetric, number][] = [
    ['LOST_TIME_INJURY', SAFETY_SCORE_WEIGHTS.lostTimeInjury],
    ['MEDICAL_TREATMENT_CASE', SAFETY_SCORE_WEIGHTS.medicalTreatmentCase],
  ];
  for (const [metric, weight] of incidents) {
    const count = n(metric);
    if (count > 0) {
      deductions.push({
        label: specFor(metric)?.label ?? metric,
        points: count * weight,
        detail: `${count} × ${weight} points`,
      });
    }
  }

  for (const [raisedMetric, closedMetric] of FINDING_PAIRS) {
    const raised = n(raisedMetric);
    const closed = n(closedMetric);
    // Closing more than was raised is normal — yesterday's findings close today
    // — and earns nothing back rather than offsetting another category.
    const open = Math.max(0, raised - closed);
    if (open > 0) {
      deductions.push({
        label: `${specFor(raisedMetric)?.label ?? raisedMetric} left open`,
        points: open * SAFETY_SCORE_WEIGHTS.openFinding,
        detail: `${raised} raised, ${closed} closed`,
      });
    }
  }

  // Nothing entered at all is a month not yet started, not a month failed.
  const recorded = Object.keys(totals).length > 0;
  if (recorded) {
    for (const metric of ACTIVITY_METRICS) {
      if (n(metric) === 0) {
        deductions.push({
          label: `No ${(specFor(metric)?.label ?? metric).toLowerCase()}`,
          points: SAFETY_SCORE_WEIGHTS.inactiveMetric,
          detail: 'None recorded this month',
        });
      }
    }
  }

  const total = deductions.reduce((a, d) => a + d.points, 0);
  deductions.sort((a, b) => b.points - a.points);
  return { score: Math.max(0, 100 - total), deductions };
}
