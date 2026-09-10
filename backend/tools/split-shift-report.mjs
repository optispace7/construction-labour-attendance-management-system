/**
 * Where the two databases disagree about the same person's day.
 *
 *   DATABASE_URL=postgres://... node tools/split-shift-report.mjs
 *
 * While some gate phones ran the old build and some the new one, a man could
 * scan in on a phone pointed at Azure and out on one pointed at D1. Neither
 * database then holds the whole shift: one has a session left open, the other
 * has a second session for the same worker on the same day.
 *
 * A plain copy cannot fix that. Worse, it cannot even run: there is a partial
 * unique index allowing one OPEN session per worker, so inserting Azure's open
 * row for a man who is already open in D1 is refused, and the copy stops.
 *
 * So this lists, per worker and work date:
 *   - sessions only in Azure
 *   - sessions only in D1
 *   - which of those days have rows on both sides, i.e. a split shift
 *
 * Reads only. Nothing is written or decided here.
 */
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? process.env.AZ_DB_URL;
if (!url) throw new Error('Set DATABASE_URL to the Azure connection string.');

function d1(sql) {
  const out = execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1', 'execute', 'clams-d1', '--remote', '--json', '--command', sql,
    ],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const azure = (
  await client.query(`
    SELECT s.id::text, s.worker_id::text AS worker_id, s.work_date::text AS work_date, s.state,
           w.full_name, w.worker_code,
           to_char(s.login_at, 'MM-DD HH24:MI') AS login_at,
           to_char(s.logout_at, 'MM-DD HH24:MI') AS logout_at
      FROM attendance_sessions s
      JOIN workers w ON w.id = s.worker_id`)
).rows;

const mine = d1(`
  SELECT s.id, s.worker_id, s.work_date, s.state, w.full_name, w.worker_code,
         s.login_at, s.logout_at
    FROM attendance_sessions s
    JOIN workers w ON w.id = s.worker_id`);

const stamp = (ms) =>
  ms == null ? null : new Date(Number(ms)).toISOString().slice(5, 16).replace('T', ' ');

const azureById = new Map(azure.map((r) => [r.id, r]));
const mineById = new Map(mine.map((r) => [String(r.id), r]));

const azureOnly = azure.filter((r) => !mineById.has(r.id));
const d1Only = mine.filter((r) => !azureById.has(String(r.id)));

const key = (r) => `${r.worker_id}|${r.work_date}`;
const azureDays = new Map();
for (const r of azureOnly) azureDays.set(key(r), [...(azureDays.get(key(r)) ?? []), r]);
const d1Days = new Map();
for (const r of d1Only) d1Days.set(key(r), [...(d1Days.get(key(r)) ?? []), r]);

console.log(`sessions only in Azure: ${azureOnly.length}`);
console.log(`sessions only in D1:    ${d1Only.length}`);

const split = [...azureDays.keys()].filter((k) => d1Days.has(k));
console.log(`\nworker-days with rows on BOTH sides: ${split.length}`);
for (const k of split) {
  const a = azureDays.get(k);
  const b = d1Days.get(k);
  console.log(`\n  ${a[0].worker_code} ${a[0].full_name}  ${a[0].work_date}`);
  for (const r of a) console.log(`    azure ${r.state.padEnd(6)} in ${r.login_at} out ${r.logout_at ?? '-'}`);
  for (const r of b)
    console.log(`    d1    ${String(r.state).padEnd(6)} in ${stamp(r.login_at)} out ${stamp(r.logout_at) ?? '-'}`);
}

// The constraint that decides whether a copy can run at all.
const openInD1 = new Set(mine.filter((r) => r.state === 'OPEN').map((r) => String(r.worker_id)));
const clash = azureOnly.filter((r) => r.state === 'OPEN' && openInD1.has(r.worker_id));
console.log(
  `\nAzure-only OPEN sessions whose worker is already OPEN in D1: ${clash.length}` +
    (clash.length ? '  (these cannot be inserted as-is)' : ''),
);
for (const r of clash) console.log(`  ${r.worker_code} ${r.full_name} in ${r.login_at}`);

await client.end();
