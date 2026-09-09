/**
 * Copies the Azure database into D1.
 *
 *   node tools/azure-to-d1.mjs [--tables=a,b] [--dry-run]
 *
 * Safe to run more than once, and a re-run brings changed rows up to date as
 * well as adding new ones. Every statement is an upsert on the primary key:
 * INSERT ... ON CONFLICT (id) DO UPDATE, so a row that already exists is
 * refreshed from Azure rather than skipped.
 *
 * That distinction is not academic. This was INSERT OR IGNORE, and Azure is
 * live: a session copied while it was still OPEN stayed OPEN in D1 for ever,
 * because the row already existed by the time the man scanned out. It left a
 * hundred people showing as on site days after they had gone home, and their
 * closing time — and any admin correction made after the first copy — never
 * arrived.
 *
 * Azure wins on conflict, which is the right way round only while Azure is the
 * system taking live scans. Once the gate devices are pointed at Workers, this
 * tool should not be run again: it would overwrite D1 with a stale copy.
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

/**
 * Hand DATE columns back as the text Postgres stores, not as a JS Date.
 *
 * node-pg parses oid 1082 into a Date at *local* midnight. On a machine east
 * of UTC that Date's toISOString() is the day before — so work_date 2026-09-09
 * copied across as 2026-09-08, and a whole day of attendance filed itself
 * under yesterday. A date here is a calendar day with no zone attached, and
 * the only safe thing to do with it is not to parse it at all.
 */
pg.types.setTypeParser(1082, (v) => v);
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--tables=')) || '').split('=')[1];
const OUT = 'tmp-d1-load';
const D1 = 'clams-d1';

/**
 * Statement order, where it matters.
 *
 * attendance_sessions carries a partial unique index — one OPEN session per
 * worker — so the order the rows are written in decides whether they fit. A
 * man who was left open in D1 by an earlier copy, and has since scanned in
 * again on Azure, has two open rows to reconcile: the update that closes the
 * old one has to run before the insert that opens the new one, or the index
 * refuses the second and the copy stops.
 *
 * Closed rows first, therefore. Within a run that is enough, because every
 * stale open in D1 is closed in Azure by now — that is why it is stale.
 */
const ORDER_BY = {
  attendance_sessions: `(CASE WHEN state = 'OPEN' THEN 1 ELSE 0 END), login_at`,
};

/**
 * Tables whose rows are deleted before being written again.
 *
 * An upsert keyed on the id cannot move a row onto a date another row still
 * occupies. These carry a unique key that includes a calendar day — one safety
 * figure per site, day and metric — so correcting a date that was copied a day
 * early collides with whichever row already sits on the corrected day, and the
 * write is refused.
 *
 * Clearing first sidesteps the ordering problem entirely, and is safe only
 * because these tables are wholly derived from Azure: nothing writes a safety
 * or waste entry into D1 that did not come from there. Checked before adding a
 * table here, not assumed.
 */
const RESET_TABLES = new Set(['daily_safety_entries', 'daily_waste_entries']);

/** Bytes stay out of D1; the rows still come, without them. */
const BLOB_COLUMNS = { photo_blobs: ['data'], company_documents: ['data'] };

/**
 * Not application data.
 *
 * _prisma_migrations is Postgres's own bookkeeping. refresh_tokens belonged to
 * the JWT scheme that was removed when auth moved to Better Auth — nothing
 * reads it, and copying another few hundred dead rows into D1 would only make
 * the database bigger and the schema more confusing to whoever reads it next.
 */
const SKIP_TABLES = new Set(['_prisma_migrations', 'refresh_tokens']);

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
    // The primary key, asked of Postgres rather than assumed to be "id":
    // user_site_scopes and the other join tables key on a pair of columns, and
    // an upsert naming the wrong column silently conflicts on nothing.
    const { rows: pk } = await client.query(
      `SELECT a.attname AS col
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        ORDER BY a.attnum`,
      [`"${table}"`],
    );
    const keyCols = pk.map((r) => r.col);

    const drop = new Set(BLOB_COLUMNS[table] ?? []);
    const use = cols.filter((c) => !drop.has(c.column_name));
    const types = Object.fromEntries(use.map((c) => [c.column_name, c.data_type]));
    const names = use.map((c) => c.column_name);

    const order = ORDER_BY[table] ? ` ORDER BY ${ORDER_BY[table]}` : '';
    const { rows } = await client.query(
      `SELECT ${names.map((n) => `"${n}"`).join(', ')} FROM "${table}"${order}`,
    );

    // Chunked: one enormous file is refused, and a failure halfway through a
    // small file is easier to place than one inside thirty thousand lines.
    const CHUNK = 250;
    let files = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const lines = rows.slice(i, i + CHUNK).map((r) => {
        const values = names.map((n) => convert(r[n], types[n])).join(',');
        const cols = names.map((n) => `"${n}"`).join(',');
        // Every column except the key itself is refreshed from what Azure now
        // holds. A table with no primary key has nothing to conflict on, so it
        // falls back to the old insert-and-skip.
        const updates = names
          .filter((n) => !keyCols.includes(n))
          .map((n) => `"${n}"=excluded."${n}"`)
          .join(',');
        if (!keyCols.length) {
          return `INSERT OR IGNORE INTO "${table}" (${cols}) VALUES (${values});`;
        }
        const target = keyCols.map((n) => `"${n}"`).join(',');
        const onConflict = updates
          ? ` ON CONFLICT(${target}) DO UPDATE SET ${updates}`
          : ` ON CONFLICT(${target}) DO NOTHING`;
        return `INSERT INTO "${table}" (${cols}) VALUES (${values})${onConflict};`;
      });
      // The clear goes at the head of the first file, so it runs before any of
      // this table's rows and never between two of them.
      if (RESET_TABLES.has(table) && files === 0) {
        lines.unshift(`DELETE FROM "${table}";`);
      }
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
  /**
   * Apply one file, retrying a network failure.
   *
   * A full run is a hundred-odd calls over several minutes, and a single DNS
   * blip — "Unable to resolve Cloudflare's API hostname" — used to end it
   * partway through with no indication which files had landed. Every statement
   * is an upsert, so repeating one is harmless; a constraint failure is not
   * transient and is raised at once.
   */
  const apply = (file) => {
    for (let attempt = 1; ; attempt++) {
      try {
        execFileSync(
          process.execPath,
          [wrangler, 'd1', 'execute', D1, '--remote', '--file', file],
          { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
        );
        return;
      } catch (e) {
        const text = String(e.stderr ?? e.message ?? '');
        const transient = /Unable to resolve|ETIMEDOUT|ECONNRESET|fetch failed|502|503|429/i.test(text);
        if (!transient || attempt >= 5) throw e;
        console.log(`  ${file}: ${attempt === 1 ? 'network hiccup, retrying' : `retry ${attempt}`}`);
        execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${attempt * 3000})`]);
      }
    }
  };

  let done = 0;
  for (const file of files) {
    apply(file);
    done++;
    if (done % 10 === 0 || done === files.length) console.log(`  applied ${done}/${files.length}`);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e?.stack ?? e?.message ?? e);
  process.exitCode = 1;
});
