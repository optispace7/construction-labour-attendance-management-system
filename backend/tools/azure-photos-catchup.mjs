/**
 * Brings worker photos and ID-card images that exist on Azure across to
 * Cloudflare, without changing anything Cloudflare already has.
 *
 *   AZ_DB_URL=<azure postgres url> node tools/azure-photos-catchup.mjs [--apply]
 *
 * A dry run by default: it reports what Azure holds that Cloudflare does not,
 * and writes nothing. --apply moves it.
 *
 * Why this exists. azure-to-d1.mjs copies photo rows without their bytes, and
 * azure-blobs-to-r2.mjs moves the bytes — but only for what existed when it
 * ran. Workers registered on Azure on 8–9 Sep 2026 came across as rows pointing
 * at images that were never moved: 45 empty images, 15 people with no photo or
 * Aadhaar in the panel or the document export. Azure is also still in use, so a
 * photo added there later has the same problem. This finds both.
 *
 * What it looks for:
 *   1. photo_blobs rows D1 has with no bytes anywhere (no storage_key, no data)
 *      whose bytes Azure still holds;
 *   2. workers whose Azure record points at an image (photo, Aadhaar front or
 *      back, ID proof) where the D1 record points at nothing.
 *
 * What it will not do:
 *   - replace an image D1 already has. If the two records point at different
 *     images, D1's is kept — it may be a newer upload — and the pair is listed;
 *   - copy workers that exist only on Azure. Those are azure-to-d1.mjs's job;
 *     they are listed so they can be.
 *
 * Every upload is read back from R2 and compared before D1 is pointed at it,
 * and the D1 updates only fill columns that are still empty, so a re-run — or
 * a change made in the panel meanwhile — cannot be overwritten.
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const BUCKET = 'clams-media';
const D1 = 'clams-d1';
const WRANGLER = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** The worker columns that point at an image. */
const REF_COLS = ['photo_url', 'aadhaar_front_photo_id', 'aadhaar_back_photo_id', 'id_proof_photo_id'];

const sha = (b) => createHash('sha256').update(b).digest('hex');
const run = (args) =>
  execFileSync(process.execPath, [WRANGLER, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Rows from D1. --json prints one result set per statement. */
const d1 = (sql) =>
  JSON.parse(run(['d1', 'execute', D1, '--remote', '--json', '--command', sql]).toString())[0]
    .results;

/** photo_url holds "/files/<id>"; the other columns hold the bare id. */
const blobIdOf = (col, value) => {
  if (!value) return null;
  if (col !== 'photo_url') return value;
  return value.startsWith('/files/') && value.length > 7 ? value.slice(7) : null;
};

const text = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v == null ? 'NULL' : String(Number(v)));
const ms = (v) => (v == null ? 'NULL' : String(new Date(v).getTime()));
const bool = (v) => (v ? '1' : '0');
const keyFor = (b) => `org/${b.organization_id}/${String(b.kind).toLowerCase()}/${b.id}`;

async function main() {
  if (!process.env.AZ_DB_URL) throw new Error('AZ_DB_URL is not set');
  const az = new pg.Client({ connectionString: process.env.AZ_DB_URL, ssl: { rejectUnauthorized: false } });
  await az.connect();
  try {
    // Metadata only. Bytes are read one image at a time, and only to move them.
    const { rows: azBlobs } = await az.query(
      `SELECT id, organization_id, mime_type, size_bytes, kind, is_compressed, is_encrypted,
              original_size_bytes, created_by, created_at, (data IS NOT NULL) AS has_data
         FROM photo_blobs`,
    );
    const { rows: azWorkers } = await az.query(
      `SELECT id, worker_code, full_name, deleted_at, ${REF_COLS.join(', ')} FROM workers`,
    );
    const d1Blobs = new Map(
      d1(
        'SELECT id, (storage_key IS NOT NULL) AS in_r2, (data IS NOT NULL) AS in_col FROM photo_blobs',
      ).map((r) => [r.id, { hasBytes: !!r.in_r2 || !!r.in_col }]),
    );
    const d1Workers = new Map(
      d1(`SELECT id, worker_code, deleted_at, ${REF_COLS.join(', ')} FROM workers`).map((r) => [r.id, r]),
    );
    const azBlob = new Map(azBlobs.map((b) => [b.id, b]));
    console.log(
      `Azure: ${azBlobs.length} images (${azBlobs.filter((b) => b.has_data).length} with bytes), ` +
        `${azWorkers.length} workers. D1: ${d1Blobs.size} images, ${d1Workers.size} workers.`,
    );

    /** blob id -> { meta, rowInD1 } */
    const moves = new Map();
    const fills = [];
    const differ = [];
    const azureOnly = [];
    const lost = [];

    // 1. D1 rows with no bytes anywhere.
    for (const [id, b] of d1Blobs) {
      if (b.hasBytes) continue;
      const a = azBlob.get(id);
      if (a?.has_data) moves.set(id, { meta: a, rowInD1: true });
      else lost.push(id);
    }

    // 2. Images Azure's worker record has and D1's does not.
    for (const aw of azWorkers) {
      if (aw.deleted_at) continue;
      const dw = d1Workers.get(aw.id);
      if (!dw) {
        azureOnly.push(`${aw.worker_code} ${aw.full_name}`);
        continue;
      }
      if (dw.deleted_at) continue;
      for (const col of REF_COLS) {
        const azId = blobIdOf(col, aw[col]);
        const d1Id = blobIdOf(col, dw[col]);
        if (!azId || azId === d1Id) continue;
        if (d1Id) {
          differ.push(`${aw.worker_code} ${col}: D1 ${dw[col]} / Azure ${aw[col]}`);
          continue;
        }
        const a = azBlob.get(azId);
        const inD1 = d1Blobs.get(azId);
        if (!inD1?.hasBytes) {
          if (!a?.has_data) {
            lost.push(azId);
            continue;
          }
          moves.set(azId, { meta: a, rowInD1: !!inD1 });
        }
        fills.push({ id: aw.id, code: aw.worker_code, name: aw.full_name, col, value: aw[col], blobId: azId });
      }
    }

    // Who each move is for, so the report names people rather than ids.
    const owners = new Map();
    for (const w of [...d1Workers.values(), ...azWorkers]) {
      for (const col of REF_COLS) {
        const id = blobIdOf(col, w[col]);
        if (id && moves.has(id)) owners.set(id, `${w.worker_code} ${col.replace(/_photo_id|_url/, '')}`);
      }
    }

    console.log(`\nImages on Azure to move to R2: ${moves.size}`);
    for (const [id, m] of moves) {
      console.log(`  ${owners.get(id) ?? '(no worker)'}  ${m.meta.kind}  ${m.meta.size_bytes} bytes  ${m.rowInD1 ? 'row in D1' : 'new row'}`);
    }
    console.log(`\nWorker image links to fill in D1: ${fills.length}`);
    for (const f of fills) console.log(`  ${f.code} ${f.name}: ${f.col}`);
    console.log(`\nDifferent image on each side (D1 kept, nothing changed): ${differ.length}`);
    for (const d of differ) console.log(`  ${d}`);
    console.log(`\nWorkers only on Azure (not copied by this tool): ${azureOnly.length}`);
    for (const w of azureOnly) console.log(`  ${w}`);
    console.log(`\nImages with no bytes on either side: ${lost.length}`);
    for (const id of lost.slice(0, 20)) console.log(`  ${id}`);

    if (!APPLY) {
      console.log('\nDry run — nothing written. Re-run with --apply to move the above.');
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), 'clams-catchup-'));
    const moved = new Set();
    const failures = [];
    const statements = [];
    try {
      for (const [id, { meta, rowInD1 }] of moves) {
        const { rows } = await az.query('SELECT data FROM photo_blobs WHERE id = $1', [id]);
        const bytes = rows[0]?.data ? Buffer.from(rows[0].data) : null;
        if (!bytes) {
          failures.push(`${id}: bytes gone from Azure`);
          continue;
        }
        const key = keyFor(meta);
        const file = join(dir, `${id}.bin`);
        const back = join(dir, `back-${id}.bin`);
        writeFileSync(file, bytes);
        try {
          // --remote is not optional: without it wrangler writes to a local
          // store, reads it back perfectly, and production sees nothing.
          run(['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file,
            '--content-type', meta.mime_type ?? 'application/octet-stream', '--remote']);
          run(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', back, '--remote']);
          if (sha(readFileSync(back)) !== sha(bytes)) throw new Error('read-back differs');
        } catch (e) {
          failures.push(`${id}: ${String(e).split('\n')[0].slice(0, 120)}`);
          continue;
        }
        moved.add(id);
        statements.push(
          rowInD1
            ? `UPDATE photo_blobs SET storage_key = ${text(key)} WHERE id = ${text(id)} AND storage_key IS NULL AND data IS NULL;`
            : `INSERT INTO photo_blobs (id, organization_id, mime_type, storage_key, data, size_bytes, kind, is_compressed, is_encrypted, original_size_bytes, created_by, created_at) VALUES (${text(id)}, ${text(meta.organization_id)}, ${text(meta.mime_type)}, ${text(key)}, NULL, ${num(meta.size_bytes)}, ${text(meta.kind)}, ${bool(meta.is_compressed)}, ${bool(meta.is_encrypted)}, ${num(meta.original_size_bytes)}, ${text(meta.created_by)}, ${ms(meta.created_at)}) ON CONFLICT(id) DO NOTHING;`,
        );
        console.log(`  moved ${owners.get(id) ?? id}`);
      }

      // Links last, and only to images that are now really there.
      const now = Date.now();
      for (const f of fills) {
        if (!moved.has(f.blobId) && !d1Blobs.get(f.blobId)?.hasBytes) continue;
        statements.push(
          `UPDATE workers SET "${f.col}" = ${text(f.value)}, updated_at = ${now} WHERE id = ${text(f.id)} AND "${f.col}" IS NULL;`,
        );
      }

      if (statements.length) {
        const sqlFile = join(dir, 'catchup.sql');
        writeFileSync(sqlFile, statements.join('\n'));
        run(['d1', 'execute', D1, '--remote', '--file', sqlFile]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    console.log(`\nApplied: ${moved.size} images moved, ${statements.length} D1 statements, ${failures.length} failed.`);
    for (const f of failures) console.log(`  ${f}`);
    if (failures.length) process.exitCode = 1;
  } finally {
    await az.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
