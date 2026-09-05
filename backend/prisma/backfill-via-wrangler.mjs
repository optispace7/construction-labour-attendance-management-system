/**
 * One-off: move photo and document bytes from Postgres into R2 using wrangler.
 *
 * The maintained path is `backfill-blobs-to-object-storage.ts`, which talks S3
 * and wants R2 access keys. This exists because the initial migration had to run
 * before any such key existed, and wrangler is already authenticated. It is
 * slower — a subprocess per object — but needs no new credential, and a
 * credential created for one migration is a credential someone has to remember
 * to revoke.
 *
 * Safe to re-run: rows that already carry a storageKey are skipped, and the
 * database column is only cleared after the object has been read back and
 * compared byte for byte.
 *
 *   node prisma/backfill-via-wrangler.mjs [--dry-run] [--concurrency=6]
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = Number(
  process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? 6,
);
const BUCKET = 'clams-media';

const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * wrangler's JS entrypoint, run through this same Node.
 *
 * Not the `.bin` shim: on Windows that is a `.cmd`, and Node refuses to
 * `execFile` one without a shell — it fails with `spawn EINVAL` for every
 * object. Going straight to the script sidesteps the shim, works the same on
 * every platform, and skips the couple of seconds `npx` costs per call, which
 * matters when there are hundreds of them.
 */
const WRANGLER = join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const wrangler = (args, opts) => run(process.execPath, [WRANGLER, ...args], opts);

async function putObject(key, bytes, contentType, dir, name) {
  const file = join(dir, name);
  await writeFile(file, bytes);
  // --remote is not optional. Without it wrangler writes to the local miniflare
  // store, reads it back perfectly, and the deployed Worker sees an empty
  // bucket — a failure that looks exactly like success.
  await wrangler(
    ['r2', 'object', 'put', `${BUCKET}/${key}`,
     '--file', file, '--content-type', contentType, '--remote'],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return file;
}

async function getObject(key, dir, name) {
  const file = join(dir, `back-${name}`);
  await wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', file, '--remote'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return readFile(file);
}

/** Runs `worker` over `items`, `limit` at a time. */
async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function move(label, rows, keyFor, clear) {
  console.log(`\n${label}: ${rows.length} to move${DRY_RUN ? ' (dry run)' : ''}`);
  if (rows.length === 0) return { moved: 0, bytes: 0 };

  const dir = await mkdtemp(join(tmpdir(), 'clams-backfill-'));
  let moved = 0;
  let bytes = 0;
  const failures = [];

  try {
    await pool(rows, CONCURRENCY, async (row, i) => {
      const source = Buffer.from(row.data);
      const key = keyFor(row);
      if (DRY_RUN) {
        console.log(`  would move ${row.id} (${source.length} B) -> ${key}`);
        return;
      }
      try {
        await putObject(key, source, row.mimeType, dir, `${row.id}.bin`);
        const back = await getObject(key, dir, `${row.id}.bin`);
        if (sha(back) !== sha(source)) {
          throw new Error('read-back does not match the source');
        }
        await clear(row.id, key);
        moved++;
        bytes += source.length;
        if (moved % 25 === 0) console.log(`  ${moved}/${rows.length}…`);
      } catch (e) {
        // Recorded, not thrown: one unreadable object should not strand the
        // other nine hundred. The row keeps its bytes and is retried next run.
        failures.push({ id: row.id, reason: String(e).split('\n')[0] });
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`${label}: ${moved} moved, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  if (failures.length) {
    console.log(`${label}: ${failures.length} FAILED (bytes left in the database):`);
    for (const f of failures.slice(0, 10)) console.log(`  ${f.id}: ${f.reason}`);
  }
  return { moved, bytes, failures: failures.length };
}

async function main() {
  const photos = await prisma.photoBlob.findMany({
    where: { storageKey: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, organizationId: true, kind: true, mimeType: true, data: true },
  });
  const docs = await prisma.companyDocument.findMany({
    where: { storageKey: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, organizationId: true, mimeType: true, data: true },
  });

  const p = await move(
    'photos',
    photos.filter((r) => r.data),
    (r) => `org/${r.organizationId}/${String(r.kind).toLowerCase()}/${r.id}`,
    (id, key) => prisma.photoBlob.update({ where: { id }, data: { storageKey: key, data: null } }),
  );
  const d = await move(
    'documents',
    docs.filter((r) => r.data),
    (r) => `org/${r.organizationId}/documents/${r.id}`,
    (id, key) =>
      prisma.companyDocument.update({ where: { id }, data: { storageKey: key, data: null } }),
  );

  console.log(
    `\nTotal moved: ${p.moved + d.moved}, ` +
      `${((p.bytes + d.bytes) / 1024 / 1024).toFixed(1)} MB, ` +
      `${(p.failures ?? 0) + (d.failures ?? 0)} failed.`,
  );
  if (!DRY_RUN) {
    console.log('Then: VACUUM FULL photo_blobs; VACUUM FULL company_documents;');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
