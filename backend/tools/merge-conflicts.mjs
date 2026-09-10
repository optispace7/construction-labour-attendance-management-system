/**
 * The rows a one-way copy would get wrong, now that both databases take writes.
 *
 *   DATABASE_URL=postgres://... node tools/merge-conflicts.mjs
 *
 * azure-to-d1.mjs upserts with Azure winning every conflict. That was right
 * while Azure was the only place a scan could land. It is not right any more:
 * a session copied to D1 and then closed on a phone running the new build is
 * still OPEN in Azure, and letting Azure win would reopen it and throw the
 * logout away.
 *
 * Three questions, then:
 *
 *   1. Shared sessions where D1 is further along than Azure — closed here,
 *      still open there. Azure must NOT win these.
 *   2. Shared sessions where Azure is further along — the ordinary case, and
 *      what the copy is for.
 *   3. Taps recorded on both sides for the same physical scan. They carry an
 *      idempotency key (organization_id, event_id); two rows with different
 *      ids and the same key cannot both exist, so the insert would be refused.
 *
 * Reads only.
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

// ---- sessions -------------------------------------------------------------

const azure = new Map(
  (
    await client.query(`
      SELECT s.id::text, s.state, w.worker_code, w.full_name,
             extract(epoch from s.logout_at) * 1000 AS logout_ms,
             s.worked_minutes
        FROM attendance_sessions s JOIN workers w ON w.id = s.worker_id`)
  ).rows.map((r) => [r.id, r]),
);

const mine = d1(`SELECT id, state, logout_at, worked_minutes FROM attendance_sessions`);

const d1Ahead = [];
const azureAhead = [];
for (const row of mine) {
  const a = azure.get(String(row.id));
  if (!a) continue; // D1-only, nothing to conflict with
  if (row.state === a.state) continue;
  if (a.state === 'OPEN' && row.state !== 'OPEN') d1Ahead.push({ a, row });
  else if (row.state === 'OPEN' && a.state !== 'OPEN') azureAhead.push({ a, row });
}

const when = (ms) => (ms == null ? '-' : new Date(Number(ms)).toISOString().slice(5, 16).replace('T', ' '));

console.log(`shared sessions: ${mine.filter((r) => azure.has(String(r.id))).length}`);
console.log(`\n1. closed in D1, still open in Azure — Azure must not win: ${d1Ahead.length}`);
for (const { a, row } of d1Ahead) {
  console.log(`   ${a.worker_code} ${a.full_name}  d1 ${row.state} out ${when(row.logout_at)}`);
}
console.log(`\n2. open in D1, closed in Azure — the ordinary catch-up: ${azureAhead.length}`);
for (const { a } of azureAhead.slice(0, 10)) console.log(`   ${a.worker_code} ${a.full_name}`);
if (azureAhead.length > 10) console.log(`   ... and ${azureAhead.length - 10} more`);

// ---- taps -----------------------------------------------------------------

const azureTaps = (
  await client.query(`SELECT id::text, organization_id::text AS org, event_id FROM attendance_taps`)
).rows;
const myTaps = d1(`SELECT id, organization_id, event_id FROM attendance_taps`);

const myByKey = new Map(
  myTaps.filter((t) => t.event_id != null).map((t) => [`${t.organization_id}|${t.event_id}`, String(t.id)]),
);
const dupKey = azureTaps.filter(
  (t) => t.event_id != null && myByKey.has(`${t.org}|${t.event_id}`) && myByKey.get(`${t.org}|${t.event_id}`) !== t.id,
);
console.log(`\n3. taps with the same idempotency key but a different id: ${dupKey.length}`);
for (const t of dupKey.slice(0, 10)) console.log(`   azure ${t.id} event ${t.event_id}`);

await client.end();
