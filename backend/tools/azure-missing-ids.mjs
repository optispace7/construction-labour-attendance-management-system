/**
 * Which rows of one table are in Azure but not in D1, by id.
 *
 * A count that is short says how many are missing; this says which, so the
 * reason can be looked at rather than guessed. Reads both sides.
 *
 *   DATABASE_URL=postgres://... node tools/azure-missing-ids.mjs attendance_sessions
 */
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const table = process.argv[2];
if (!table) throw new Error('Name a table.');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL to the Azure connection string.');

const d1 = (sql) => {
  const out = execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1', 'execute', 'clams-d1', '--remote', '--json', '--command', sql,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
};

const client = new pg.Client({ connectionString: url });
await client.connect();
const azure = (await client.query(`SELECT id::text FROM ${table}`)).rows.map((r) => r.id);

const inD1 = new Set(d1(`SELECT id FROM ${table}`).map((r) => r.id));
const missing = azure.filter((id) => !inD1.has(id));

console.log(`azure ${azure.length}, d1 ${inD1.size}, missing ${missing.length}`);
if (missing.length) {
  // The rows themselves, so the reason is visible rather than inferred.
  const rows = (
    await client.query(`SELECT * FROM ${table} WHERE id = ANY($1::uuid[])`, [missing])
  ).rows;
  for (const r of rows) console.log(' ', JSON.stringify(r));
}
await client.end();
