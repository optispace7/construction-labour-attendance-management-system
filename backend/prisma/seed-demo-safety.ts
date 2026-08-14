/**
 * Demo data for the safety statistics board.
 *
 * The board reads DailySafetyEntry, which was empty in every environment, so
 * the page rendered as a row of dashes and the new score had nothing to score.
 * This fills the daily task sheet across last month and this one, with numbers
 * shaped to exercise the whole card: findings both closed and left open, and an
 * incident of each kind so every deduction the score can make appears at least
 * once.
 *
 * Only active sites are filled. A disabled site has nobody working at it, and
 * its entries would still be counted by the all-sites score.
 *
 * Deterministic — the same seed produces the same month every run, so a demo
 * can be repeated and a screenshot still matches.
 *
 * Run from backend/:
 *   DATABASE_URL=... npx ts-node prisma/seed-demo-safety.ts          # create
 *   DATABASE_URL=... npx ts-node prisma/seed-demo-safety.ts --undo   # remove
 *
 * Undo deletes by the ids written to seed-demo-safety-ids.json, so a real entry
 * typed by a Safety Officer in the same window is never touched.
 */
import { PrismaClient, SafetyMetric } from '@prisma/client';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();
const IDS_FILE = join(__dirname, 'seed-demo-safety-ids.json');
const DAY_MS = 86_400_000;

/** Deterministic PRNG, so "random" numbers are the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How a site behaves, so several sites do not read as the same site repeated.
 *
 * `closeRate` is what makes the score differ: findings raised and not closed
 * are the one deduction a site controls day to day. Profiles are handed out in
 * order to whatever active sites exist — the first is the one a demo lands on,
 * so it carries an incident of each kind and shows the full deduction list.
 */
interface SiteProfile {
  seed: number;
  /** Share of findings closed within the month. */
  closeRate: number;
  /** Incidents to place across the current month. */
  medicalTreatmentCases: number;
  lostTimeInjuries: number;
}

const PROFILES: SiteProfile[] = [
  { seed: 20260801, closeRate: 0.88, medicalTreatmentCases: 1, lostTimeInjuries: 1 },
  { seed: 20260802, closeRate: 0.72, medicalTreatmentCases: 1, lostTimeInjuries: 0 },
  { seed: 20260803, closeRate: 0.95, medicalTreatmentCases: 0, lostTimeInjuries: 0 },
];

/** Both months the board can reach from today without changing the date box. */
const WINDOWS = [
  { start: '2026-07-01', end: '2026-07-31', current: false },
  { start: '2026-08-01', end: '2026-08-14', current: true },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const midnight = (v: string) => new Date(`${v}T00:00:00.000Z`);

/** Sunday is off, so the board shows the working week the site actually keeps. */
const isWorkingDay = (d: Date) => d.getUTCDay() !== 0;

/** A day's numbers for one site. Findings are raised here; closures come after. */
function dayValues(rand: () => number): Partial<Record<SafetyMetric, number>> {
  const pick = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  return {
    TOOLBOX_TALK: pick(1, 3),
    LABOUR_INDUCTION: pick(0, 6),
    VISITOR_INDUCTION: pick(0, 4),
    TRAINING: rand() < 0.35 ? pick(1, 2) : 0,
    UNSAFE_ACTS: rand() < 0.55 ? pick(1, 3) : 0,
    UNSAFE_CONDITIONS: rand() < 0.45 ? pick(1, 2) : 0,
    SAFETY_OBSERVATION: rand() < 0.6 ? pick(1, 4) : 0,
    NEAR_MISS: rand() < 0.15 ? 1 : 0,
    FIRST_AID: rand() < 0.12 ? 1 : 0,
    WORK_PERMIT: pick(1, 5),
    SAFETY_INSPECTION: rand() < 0.5 ? pick(1, 2) : 0,
    SAFETY_AUDIT: rand() < 0.1 ? 1 : 0,
    WASTE_DISPOSAL: rand() < 0.4 ? pick(1, 3) : 0,
    // Placed by hand below rather than rolled daily: an injury is an event.
    MEDICAL_TREATMENT_CASE: 0,
    LOST_TIME_INJURY: 0,
  };
}

async function seed() {
  if (existsSync(IDS_FILE)) {
    console.error(
      `${IDS_FILE} already exists — this seed has been run and not undone.\n` +
        'Run with --undo first, or delete that file if you know the rows are gone.',
    );
    process.exit(1);
  }

  /**
   * Only sites that are switched on.
   *
   * A disabled site is one nobody is working at, so a daily task sheet for it
   * is not just noise — it feeds the all-sites score, which sums deductions
   * across every site the org has rather than only the live ones.
   */
  const allSites = await prisma.site.findMany({
    select: { id: true, name: true, isActive: true, organizationId: true },
    orderBy: { createdAt: 'asc' },
  });
  const sites = allSites.filter((s) => s.isActive);
  const skippedSites = allSites.filter((s) => !s.isActive);
  if (skippedSites.length) {
    console.log(`Skipping disabled site(s): ${skippedSites.map((s) => s.name.trim()).join(', ')}`);
  }
  if (!sites.length) {
    console.error('No active sites — nothing to seed.');
    process.exit(1);
  }

  const rows: {
    organizationId: string;
    siteId: string;
    entryDate: Date;
    metric: SafetyMetric;
    value: number;
  }[] = [];

  for (const [i, siteRow] of sites.entries()) {
    const site = PROFILES[i % PROFILES.length];
    const rand = rng(site.seed);
    console.log(`Seeding ${siteRow.name.trim()} (close rate ${site.closeRate})`);

    for (const window of WINDOWS) {
      // Raised counts first, so closures can be derived against the real total
      // rather than guessed day by day.
      const days: { date: Date; values: Partial<Record<SafetyMetric, number>> }[] = [];
      for (let t = midnight(window.start).getTime(); t <= midnight(window.end).getTime(); t += DAY_MS) {
        const date = new Date(t);
        if (!isWorkingDay(date)) continue;
        days.push({ date, values: dayValues(rand) });
      }

      // Incidents land on real working days rather than being spread evenly —
      // an injury is an event, not a rate.
      if (window.current) {
        const place = (metric: SafetyMetric, count: number) => {
          for (let i = 0; i < count; i++) {
            const day = days[Math.floor(rand() * days.length)];
            day.values[metric] = (day.values[metric] ?? 0) + 1;
          }
        };
        place('MEDICAL_TREATMENT_CASE', site.medicalTreatmentCases);
        place('LOST_TIME_INJURY', site.lostTimeInjuries);
      }

      /**
       * Closures, spread back across the month at the site's close rate.
       *
       * Deliberately not same-day: a finding raised on the 9th and closed on
       * the 11th is the normal case, and the month's totals are what the score
       * reads anyway.
       */
      for (const [raisedMetric, closedMetric] of [
        ['UNSAFE_ACTS', 'UNSAFE_ACTS_CLOSED'],
        ['UNSAFE_CONDITIONS', 'UNSAFE_CONDITIONS_CLOSED'],
        ['SAFETY_OBSERVATION', 'SAFETY_OBSERVATION_CLOSED'],
      ] as [SafetyMetric, SafetyMetric][]) {
        const raised = days.reduce((a, d) => a + (d.values[raisedMetric] ?? 0), 0);
        let toClose = Math.round(raised * site.closeRate);
        // Walk the days in order, closing what each one can carry.
        for (const day of days) {
          if (toClose <= 0) break;
          const cap = Math.min(toClose, (day.values[raisedMetric] ?? 0) + 1);
          if (cap <= 0) continue;
          day.values[closedMetric] = (day.values[closedMetric] ?? 0) + cap;
          toClose -= cap;
        }
      }

      for (const day of days) {
        for (const [metric, value] of Object.entries(day.values)) {
          if (!value) continue;
          rows.push({
            organizationId: siteRow.organizationId,
            siteId: siteRow.id,
            entryDate: day.date,
            metric: metric as SafetyMetric,
            value,
          });
        }
      }
    }
  }

  const created: string[] = [];
  for (const row of rows) {
    // Upsert rather than create: the unique index is (site, date, metric), and
    // a rerun after a partial failure must not collide.
    const saved = await prisma.dailySafetyEntry.upsert({
      where: {
        siteId_entryDate_metric: {
          siteId: row.siteId,
          entryDate: row.entryDate,
          metric: row.metric,
        },
      },
      create: row,
      update: { value: row.value },
      select: { id: true },
    });
    created.push(saved.id);
  }

  writeFileSync(
    IDS_FILE,
    JSON.stringify({ createdAt: new Date().toISOString(), ids: created }, null, 2),
  );
  console.log(`Wrote ${created.length} safety entries across ${sites.length} active site(s).`);
  console.log(`Ids recorded in ${IDS_FILE} — undo removes exactly these.`);
}

async function undo() {
  if (!existsSync(IDS_FILE)) {
    console.error(`${IDS_FILE} not found — nothing recorded to undo.`);
    process.exit(1);
  }
  const { ids } = JSON.parse(readFileSync(IDS_FILE, 'utf8')) as { ids: string[] };
  const { count } = await prisma.dailySafetyEntry.deleteMany({ where: { id: { in: ids } } });
  console.log(`Deleted ${count} of ${ids.length} recorded entries.`);
  writeFileSync(IDS_FILE.replace('.json', '-undone.json'), JSON.stringify({ ids }, null, 2));
  console.log('Now delete seed-demo-safety-ids.json to allow a fresh seed.');
}

(process.argv.includes('--undo') ? undo() : seed())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
