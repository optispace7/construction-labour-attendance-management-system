/**
 * Moves photo bytes out of the database and into object storage.
 *
 * Safe to run against a live system, and safe to run twice. Rows already
 * carrying a storageKey are skipped, the app reads from either place while this
 * is in progress, and the database column is only cleared once the object has
 * been written and read back.
 *
 * The bytes are copied verbatim. Aadhaar and ID images are already encrypted
 * when they reach this script and stay that way — nothing here holds a key, so
 * a mistake cannot expose one, and the same ciphertext lands in the bucket.
 *
 *   npx ts-node prisma/backfill-photos-to-object-storage.ts [--dry-run] [--batch=50]
 *
 * Afterwards, Postgres does not shrink on its own: run
 *   VACUUM FULL photo_blobs;
 * (or pg_repack, to avoid the exclusive lock) or the space is never returned.
 */
import { PrismaClient } from '@prisma/client';
import { blobStore, blobStoreConfigured } from '../src/modules/files/blob-store';
import { createHash } from 'node:crypto';

const prisma = new PrismaClient();

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = Number(process.argv.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? 50);

function storageKey(organizationId: string, id: string, kind: string): string {
  return `org/${organizationId}/${kind.toLowerCase()}/${id}`;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
  if (!blobStoreConfigured()) {
    throw new Error(
      'Object storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and ' +
        'R2_SECRET_ACCESS_KEY (and R2_BUCKET if it is not clams-media).',
    );
  }

  const total = await prisma.photoBlob.count({ where: { storageKey: null } });
  console.log(`${total} photo(s) still in the database${DRY_RUN ? ' (dry run)' : ''}`);
  if (total === 0) return;

  let moved = 0;
  let skipped = 0;
  let bytes = 0;

  for (;;) {
    const batch = await prisma.photoBlob.findMany({
      where: { storageKey: null },
      // Oldest first, so a run interrupted halfway leaves a predictable
      // boundary rather than a scattering of migrated rows.
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true, organizationId: true, kind: true, mimeType: true, data: true },
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      if (!row.data) {
        // No bytes in either place: a dangling row. Left alone deliberately —
        // deleting records is not this script's job.
        console.warn(`  ${row.id}: no data and no storageKey, skipped`);
        skipped++;
        continue;
      }

      const source = Buffer.from(row.data);
      const key = storageKey(row.organizationId, row.id, row.kind);

      if (DRY_RUN) {
        console.log(`  would move ${row.id} (${source.length} bytes) -> ${key}`);
        moved++;
        bytes += source.length;
        continue;
      }

      await blobStore.put(key, source, row.mimeType);

      // Read back and compare before clearing the column. Trusting the write
      // and dropping the only other copy of somebody's Aadhaar photo on faith
      // is not a trade worth making for the time it saves.
      const written = await blobStore.get(key);
      if (!written || sha(written) !== sha(source)) {
        throw new Error(
          `Verification failed for ${row.id}: the object read back does not match. ` +
            'Nothing has been deleted; fix the cause and re-run.',
        );
      }

      await prisma.photoBlob.update({
        where: { id: row.id },
        data: { storageKey: key, data: null },
      });

      moved++;
      bytes += source.length;
    }

    console.log(`  ${moved}/${total} moved…`);
    if (DRY_RUN) break; // nothing is written, so the query would loop for ever
  }

  console.log(
    `\nDone. ${moved} moved, ${skipped} skipped, ${(bytes / 1024 / 1024).toFixed(1)} MB.`,
  );
  if (!DRY_RUN) {
    console.log('Run "VACUUM FULL photo_blobs;" to actually return the space to disk.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
