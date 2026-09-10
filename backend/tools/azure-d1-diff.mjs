/**
 * A two-way diff between Azure and D1, by row id.
 *
 *   DATABASE_URL=postgres://... node tools/azure-d1-diff.mjs [--table=x]
 *
 * azure-vs-d1.mjs compares counts, which is enough while the copy only ever
 * runs one way. It stopped being enough the moment both databases started
 * taking live writes: some gate phones went onto the new build and scanned
 * into D1 while the rest stayed on the old one and scanned into Azure. Equal
 * counts would now hide two different sets of rows, and the one-way copy tool
 * would overwrite whichever side it did not read.
 *
 * So this reports both directions:
 *
 *   azure only — rows the copy still has to bring across
 *   d1 only    — rows that exist ONLY here, which nothing may delete
 *   common     — the same id on both sides
 *
 * It reads and writes nothing. Decide from the output, then act.
 */
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? process.env.AZ_DB_URL;
if (!url) throw new Error('Set DATABASE_URL to the Azure connection string.');
const ONLY = (process.argv.find((a) => a.startsWith('--table=')) || '').split('=')[1];

/** Not application data — see azure-to-d1.mjs for why these two are skipped. */
const SKIP = new Set(['_prisma_migrations', 'refresh_tokens']);

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

const { rows: tables } = await client.query(`
  SELECT c.relname AS table
  FROM pg_stat_user_tables c
  ORDER BY c.relname`);

console.log(
  `${'table'.padEnd(28)} ${'azure'.padStart(7)} ${'d1'.padStart(7)} ` +
    `${'az only'.padStart(8)} ${'d1 only'.padStart(8)}`,
);

const report = [];
for (const { table } of tables) {
  if (SKIP.has(table)) continue;
  if (ONLY && table !== ONLY) continue;

  // Only tables keyed on a single "id" column can be compared this way; the
  // join tables key on a pair and are handled by count alone.
  const { rows: hasId } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`,
    [table],
  );
  if (!hasId.length) continue;

  const azure = new Set((await client.query(`SELECT id::text FROM "${table}"`)).rows.map((r) => r.id));
  const mine = new Set(d1(`SELECT id FROM "${table}"`).map((r) => String(r.id)));

  const azureOnly = [...azure].filter((id) => !mine.has(id));
  const d1Only = [...mine].filter((id) => !azure.has(id));

  report.push({ table, azure: azure.size, d1: mine.size, azureOnly, d1Only });
  const flag = d1Only.length ? '  <-- d1 has rows Azure does not' : '';
  console.log(
    `${table.padEnd(28)} ${String(azure.size).padStart(7)} ${String(mine.size).padStart(7)} ` +
      `${String(azureOnly.length).padStart(8)} ${String(d1Only.length).padStart(8)}${flag}`,
  );
}

await client.end();

const split = report.filter((r) => r.azureOnly.length && r.d1Only.length);
if (split.length) {
  console.log('\nWritten on both sides since the split:');
  for (const r of split) {
    console.log(`  ${r.table}: ${r.azureOnly.length} only in Azure, ${r.d1Only.length} only in D1`);
  }
}
