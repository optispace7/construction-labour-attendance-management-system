/**
 * Moves photo and company-document bytes out of the database into object storage.
 *
 * Safe against a live system, and safe to run twice. Rows that already carry a
 * storageKey are skipped, the app reads from either place while this runs, and
 * a row's column is cleared only after the object has been written and read
 * back and compared.
 *
 * Bytes are copied verbatim. Aadhaar and ID images arrive already encrypted and
 * stay that way — nothing here holds a key, so a mistake cannot expose one, and
 * the same ciphertext lands in the bucket.
 *
 *   npx ts-node prisma/backfill-blobs-to-object-storage.ts [--dry-run] [--batch=50]
 *
 * Postgres does not shrink on its own afterwards. Until you run
 *   VACUUM FULL photo_blobs; VACUUM FULL company_documents;
 * (or pg_repack, to avoid the exclusive lock) the space is not returned and the
 * whole exercise looks like it did nothing.
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { blobStore, blobStoreConfigured } from '../src/modules/files/blob-store';

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = Number(process.argv.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? 50);

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Row {
  id: string;
  organizationId: string;
  mimeType: string;
  data: Uint8Array | null;
}

/**
 * Moves one table's bytes.
 *
 * `keyFor` differs per table but the contract does not: write, read back,
 * compare, and only then clear the column. Dropping the only other copy of
 * somebody's Aadhaar photo because a write returned success is not a trade
 * worth making for the time it saves.
 */
async function move(
  label: string,
  count: () => Promise<number>,
  page: () => Promise<Row[]>,
  keyFor: (row: Row) => string,
  clear: (id: string, key: string) => Promise<unknown>,
): Promise<void> {
  const total = await count();
  console.log(`\n${total} ${label}(s) still in the database${DRY_RUN ? ' (dry run)' : ''}`);
  if (total === 0) return;

  let moved = 0;
  let skipped = 0;
  let bytes = 0;

  for (;;) {
    const batch = await page();
    if (batch.length === 0) break;

    for (const row of batch) {
      if (!row.data) {
        // Nothing in either place: a dangling row. Left alone on purpose —
        // deleting records is not this script's job.
        console.warn(`  ${row.id}: no data and no storageKey, skipped`);
        skipped++;
        continue;
      }

      const source = Buffer.from(row.data);
      const key = keyFor(row);

      if (DRY_RUN) {
        console.log(`  would move ${row.id} (${source.length} bytes) -> ${key}`);
        moved++;
        bytes += source.length;
        continue;
      }

      await blobStore.put(key, source, row.mimeType);

      const written = await blobStore.get(key);
      if (!written || sha(written) !== sha(source)) {
        throw new Error(
          `Verification failed for ${label} ${row.id}: the object read back does not ` +
            'match the source. Nothing has been deleted; fix the cause and re-run.',
        );
      }

      await clear(row.id, key);
      moved++;
      bytes += source.length;
    }

    console.log(`  ${moved}/${total} moved…`);
    // Nothing is written in a dry run, so the same page would come back for ever.
    if (DRY_RUN) break;
  }

  console.log(
    `${label}s: ${moved} moved, ${skipped} skipped, ${(bytes / 1024 / 1024).toFixed(1)} MB.`,
  );
}

async function main() {
  if (!blobStoreConfigured()) {
    throw new Error(
      'Object storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and ' +
        'R2_SECRET_ACCESS_KEY (and R2_BUCKET if it is not clams-media).',
    );
  }

  await move(
    'photo',
    () => prisma.photoBlob.count({ where: { storageKey: null } }),
    () =>
      prisma.photoBlob.findMany({
        where: { storageKey: null },
        // Oldest first, so an interrupted run leaves a predictable boundary
        // rather than a scattering of migrated rows.
        orderBy: { createdAt: 'asc' },
        take: BATCH,
        select: { id: true, organizationId: true, kind: true, mimeType: true, data: true },
      }) as Promise<Row[]>,
    (row) =>
      `org/${row.organizationId}/${String((row as Row & { kind: string }).kind).toLowerCase()}/${row.id}`,
    (id, key) => prisma.photoBlob.update({ where: { id }, data: { storageKey: key, data: null } }),
  );

  // Fewer rows than photos but far larger each — a licence scan is allowed up
  // to 8 MB — so this is where a database on a small plan actually runs out.
  await move(
    'document',
    () => prisma.companyDocument.count({ where: { storageKey: null } }),
    () =>
      prisma.companyDocument.findMany({
        where: { storageKey: null },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
        select: { id: true, organizationId: true, mimeType: true, data: true },
      }) as Promise<Row[]>,
    (row) => `org/${row.organizationId}/documents/${row.id}`,
    (id, key) =>
      prisma.companyDocument.update({ where: { id }, data: { storageKey: key, data: null } }),
  );

  if (!DRY_RUN) {
    console.log(
      '\nRun "VACUUM FULL photo_blobs; VACUUM FULL company_documents;" to return the space.',
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
