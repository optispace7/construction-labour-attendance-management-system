/**
 * Copies the Azure database into D1.
 *
 *   node tools/azure-to-d1.mjs [--tables=a,b] [--dry-run]
 *
 * Safe to run more than once. Every statement is INSERT OR IGNORE keyed on the
 * row's existing primary key, so a second run skips what is already there
 * rather than writing it twice — which matters because Azure is still live and
 * this will need running again to pick up whatever it collects in the meantime.
 *
 * Ids are carried across unchanged. That is what makes a re-run cheap and every
 * foreign key still line up afterwards: nothing is remapped, so a row's
 * relationships mean the same thing in both databases.
 *
 * The type conversions are driven by Postgres's own column types rather than a
 * hand-written list, so a column nobody remembered still converts correctly:
 *
 *   timestamptz -> integer, epoch milliseconds  (SQLite has no timestamp type)
 *   date        -> 'YYYY-MM-DD' text            (a day, not an instant)
 *   time        -> 'HH:MM:SS' text
 *   boolean     -> 1 / 0
 *   bytea       -> X'..' blob literal           (ciphertext, byte for byte)
 *   json/jsonb  -> text
 *
 * Photo and document bytes are deliberately NOT copied into D1. They belong in
 * R2, the way they already do for Supabase; the rows come across with their
 * metadata and storage_key and a null data column. See azure-blobs-to-r2.mjs.
 */
import pg from 'pg';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--tables=')) || '').split('=')[1];
const OUT = 'tmp-d1-load';
const D1 = 'clams-d1';

/** Bytes stay out of D1; the rows still come, without them. */
const BLOB_COLUMNS = { photo_blobs: ['data'], company_documents: ['data'] };

/** Not application data — D1 has its own migration bookkeeping. */
const SKIP_TABLES = new Set(['_prisma_migrations']);

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function convert(value, type) {
  if (value === null || value === undefined) return 'NULL';
  switch (type) {
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return String(new Date(value).getTime());
    case 'date':
      return lit(value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
    case 'time without time zone':
    case 'time with time zone':
      return lit(String(value).slice(0, 8));
    case 'boolean':
      return value ? '1' : '0';
    case 'bytea':
      return `X'${Buffer.from(value).toString('hex')}'`;
    case 'json':
    case 'jsonb':
      return lit(JSON.stringify(value));
    case 'integer':
    case 'bigint':
    case 'smallint':
    case 'numeric':
    case 'double precision':
    case 'real':
      return String(value);
    case 'ARRAY':
      return lit(JSON.stringify(value));
    default:
      return lit(value);
  }
}

async function main() {
  const client = new pg.Client({
    connectionString: process.env.AZ_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const { rows: tables } = await client.query(`
    SELECT c.relname AS table
    FROM pg_stat_user_tables c
    WHERE c.n_live_tup > 0
    ORDER BY c.n_live_tup ASC`);

  const wanted = ONLY ? new Set(ONLY.split(',')) : null;
  const summary = [];

  for (const { table } of tables) {
    if (SKIP_TABLES.has(table)) continue;
    if (wanted && !wanted.has(table)) continue;

    const { rows: cols } = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    const drop = new Set(BLOB_COLUMNS[table] ?? []);
    const use = cols.filter((c) => !drop.has(c.column_name));
    const types = Object.fromEntries(use.map((c) => [c.column_name, c.data_type]));
    const names = use.map((c) => c.column_name);

    const { rows } = await client.query(
      `SELECT ${names.map((n) => `"${n}"`).join(', ')} FROM "${table}"`,
    );

    // Chunked: one enormous file is refused, and a failure halfway through a
    // small file is easier to place than one inside thirty thousand lines.
    const CHUNK = 250;
    let files = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const lines = rows.slice(i, i + CHUNK).map((r) => {
        const values = names.map((n) => convert(r[n], types[n])).join(',');
        return `INSERT OR IGNORE INTO "${table}" (${names
          .map((n) => `"${n}"`)
          .join(',')}) VALUES (${values});`;
      });
      const file = join(OUT, `${String(files).padStart(3, '0')}_${table}.sql`);
      writeFileSync(file, lines.join('\n'));
      files++;
    }
    summary.push({ table, rows: rows.length, files, droppedColumns: [...drop] });
    console.log(
      `  ${table.padEnd(28)} ${String(rows.length).padStart(6)} rows -> ${files} file(s)` +
        (drop.size ? `  (bytes left for R2: ${[...drop].join(', ')})` : ''),
    );
  }

  await client.end();

  const total = summary.reduce((n, s) => n + s.rows, 0);
  console.log(`\nprepared ${total} rows across ${summary.length} tables`);
  if (DRY) {
    console.log('dry run — nothing applied');
    return;
  }

  const wrangler = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const files = summary.flatMap((s) =>
    Array.from({ length: s.files }, (_, i) =>
      join(OUT, `${String(i).padStart(3, '0')}_${s.table}.sql`),
    ),
  );
  let done = 0;
  for (const file of files) {
    execFileSync(process.execPath, [wrangler, 'd1', 'execute', D1, '--remote', '--file', file], {
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    done++;
    if (done % 10 === 0 || done === files.length) console.log(`  applied ${done}/${files.length}`);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
