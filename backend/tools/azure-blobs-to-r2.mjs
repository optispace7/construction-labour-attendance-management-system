/**
 * Moves photo and document bytes from Azure's Postgres into R2, and points the
 * D1 rows at them.
 *
 *   node tools/azure-blobs-to-r2.mjs [--dry-run]
 *
 * Two things make this safe to run repeatedly.
 *
 * The key is derived from the row's own id — org/<org>/<kind>/<id> — so it is
 * the same key the Supabase migration already used. An object that is already
 * there is skipped rather than re-uploaded, and the 913 photos moved in
 * September are recognised as present instead of being sent again.
 *
 * Every upload is read back and compared before the row is pointed at it. A
 * photo whose bytes did not survive is worse than one that has not moved yet:
 * the first looks done.
 *
 * Why this is separate from the row copy: Azure's schema predates the move to
 * object storage and has no storage_key column at all, so the rows arrive in D1
 * with neither bytes nor a key — which is a broken image, not an empty one.
 * This is the step that makes them whole.
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const BUCKET = 'clams-media';
const D1 = 'clams-d1';
const WRANGLER = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const run = (args, opts = {}) =>
  execFileSync(process.execPath, [WRANGLER, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });

/**
 * Ids already known to be in R2, from Supabase's own storage_key column.
 *
 * Probing R2 for each of the ~964 objects would mean a wrangler subprocess per
 * object and the better part of an hour, almost all of it confirming what the
 * September migration already recorded. Supabase is the register of what was
 * moved, so it is asked once instead.
 */
async function knownInR2() {
  const vars = readFileSync('.dev.vars', 'utf8');
  const line = vars.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  const url = line ? line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') : null;
  if (!url) return new Set();
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const ids = new Set();
    for (const t of ['photo_blobs', 'company_documents']) {
      const { rows } = await c.query(`SELECT id FROM ${t} WHERE storage_key IS NOT NULL`);
      rows.forEach((r) => ids.add(r.id));
    }
    return ids;
  } finally {
    await c.end();
  }
}

function alreadyInR2(key, dir) {
  try {
    run(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', join(dir, 'probe.bin'), '--remote']);
    return true;
  } catch {
    return false;
  }
}

async function move(client, { table, keyOf, label }, known) {
  const { rows } = await client.query(
    `SELECT * FROM "${table}" WHERE data IS NOT NULL ORDER BY created_at ASC`,
  );
  console.log(`\n${label}: ${rows.length} with bytes in Postgres`);

  const dir = mkdtempSync(join(tmpdir(), 'clams-az-'));
  let uploaded = 0;
  let skipped = 0;
  const failures = [];
  const keys = [];

  try {
    for (const row of rows) {
      const key = keyOf(row);
      if (DRY) {
        keys.push({ id: row.id, key });
        continue;
      }

      // Recorded as moved in September, under this same key, so it is there.
      if (known.has(row.id) || alreadyInR2(key, dir)) {
        skipped++;
        keys.push({ id: row.id, key });
        continue;
      }
      const source = Buffer.from(row.data);
      const file = join(dir, `${row.id}.bin`);
      writeFileSync(file, source);
      try {
        // --remote is not optional. Without it wrangler writes to the local
        // store, reads it back perfectly, and the deployed Worker sees nothing.
        run([
          'r2', 'object', 'put', `${BUCKET}/${key}`,
          '--file', file, '--content-type', row.mime_type ?? 'application/octet-stream',
          '--remote',
        ]);
        const back = join(dir, `back-${row.id}.bin`);
        run(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', back, '--remote']);
        if (sha(readFileSync(back)) !== sha(source)) throw new Error('read-back differs');
        // Only now is the row pointed at the object. Recording the key for an
        // upload that failed would leave a row referencing something that is
        // not there — a broken image that looks migrated, which is worse than
        // one that plainly has not moved yet.
        keys.push({ id: row.id, key });
        uploaded++;
        if (uploaded % 10 === 0) console.log(`  uploaded ${uploaded}…`);
      } catch (e) {
        // Recorded, not thrown: one bad object should not strand the rest, and
        // the row keeps its bytes in Azure so a re-run picks it up.
        failures.push({ id: row.id, reason: String(e).split('\n')[0].slice(0, 120) });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`${label}: ${uploaded} uploaded, ${skipped} already there, ${failures.length} failed`);
  for (const f of failures.slice(0, 5)) console.log(`  ${f.id}: ${f.reason}`);
  return { keys, failures: failures.length };
}

/** Points the D1 rows at their objects, in batches. */
function setStorageKeys(table, keys) {
  if (DRY || !keys.length) return;
  const dir = mkdtempSync(join(tmpdir(), 'clams-keys-'));
  try {
    const CHUNK = 400;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const lines = keys
        .slice(i, i + CHUNK)
        .map(
          ({ id, key }) =>
            `UPDATE "${table}" SET storage_key = '${key.replace(/'/g, "''")}' WHERE id = '${id}';`,
        );
      const file = join(dir, `keys-${i}.sql`);
      writeFileSync(file, lines.join('\n'));
      run(['d1', 'execute', D1, '--remote', '--file', file]);
    }
    console.log(`${table}: storage_key set on ${keys.length} rows`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const client = new pg.Client({
    connectionString: process.env.AZ_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const known = await knownInR2();
    console.log(`${known.size} objects already recorded as moved to R2`);
    const photos = await move(client, {
      table: 'photo_blobs',
      label: 'photos',
      keyOf: (r) => `org/${r.organization_id}/${String(r.kind).toLowerCase()}/${r.id}`,
    }, known);
    const docs = await move(client, {
      table: 'company_documents',
      label: 'documents',
      keyOf: (r) => `org/${r.organization_id}/documents/${r.id}`,
    }, known);
    setStorageKeys('photo_blobs', photos.keys);
    setStorageKeys('company_documents', docs.keys);
    if (photos.failures || docs.failures) {
      console.log('\nSome objects failed. Re-run — anything already uploaded is skipped.');
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
