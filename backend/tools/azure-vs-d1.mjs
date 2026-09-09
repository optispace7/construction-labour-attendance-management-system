/**
 * Row counts in Azure Postgres next to the same counts in D1.
 *
 * Run before and after a top-up: before, to see what is missing; after, to see
 * that it is not any more. Reads both sides, writes to neither.
 *
 *   DATABASE_URL=postgres://... node tools/azure-vs-d1.mjs
 */
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL to the Azure connection string.');

/** The tables that hold data worth comparing, in dependency order. */
const TABLES = [
  'organizations',
  'sites',
  'site_settings',
  'shifts',
  'vendors',
  'designations',
  'users',
  'user_site_scopes',
  'workers',
  'worker_site_assignments',
  'worker_credentials',
  'devices',
  'attendance_taps',
  'attendance_sessions',
  'correction_requests',
  'correction_items',
  'manual_attendance_requests',
  'daily_safety_entries',
  'waste_types',
  'daily_waste_entries',
  'company_documents',
  'photo_blobs',
  'notifications',
  'push_tokens',
  'sos_events',
  'report_jobs',
  'audit_logs',
  'sync_batches',
  'sync_events',
];

/**
 * One query against D1, returning its rows.
 *
 * --command, not --file: given a file wrangler reports a summary — how many
 * statements ran and how many rows were read — instead of the rows themselves,
 * which reads as every table being empty. And run through node directly with
 * no shell, so the SQL is one argument rather than something a Windows command
 * line gets to re-split on quotes and parentheses.
 */
const d1 = (sql) => {
  const out = execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1', 'execute', 'clams-d1', '--remote', '--json', '--command', sql,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
};

const client = new pg.Client({ connectionString: url });
await client.connect();

// One query per side rather than one per table: 29 round trips to D1 is slow
// and the counts are small.
const union = TABLES.map((t) => `SELECT '${t}' AS t, count(*) AS n FROM ${t}`).join(' UNION ALL ');
const pgRows = (await client.query(union)).rows;
await client.end();

// A row of scalar subqueries, not a UNION: D1 caps the terms in a compound
// SELECT well below SQLite's own default. Chunked, because the column list
// gets long.
const d1Rows = [];
for (let i = 0; i < TABLES.length; i += 12) {
  const part = TABLES.slice(i, i + 12);
  const [row] = d1('SELECT ' + part.map((t) => `(SELECT count(*) FROM ${t}) AS ${t}`).join(', '));
  for (const t of part) d1Rows.push({ t, n: row?.[t] ?? 0 });
}

const pgBy = new Map(pgRows.map((r) => [r.t, Number(r.n)]));
const d1By = new Map(d1Rows.map((r) => [r.t, Number(r.n)]));

let behind = 0;
console.log(`${'table'.padEnd(28)} ${'azure'.padStart(8)} ${'d1'.padStart(8)}   diff`);
for (const t of TABLES) {
  const a = pgBy.get(t) ?? 0;
  const b = d1By.get(t) ?? 0;
  const diff = a - b;
  if (diff > 0) behind += diff;
  const mark = diff > 0 ? `  MISSING ${diff}` : diff < 0 ? `  d1 has ${-diff} more` : '';
  console.log(`${t.padEnd(28)} ${String(a).padStart(8)} ${String(b).padStart(8)}${mark}`);
}
console.log(`\n${behind} row(s) in Azure are not in D1.`);
