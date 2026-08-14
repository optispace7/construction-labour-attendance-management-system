/**
 * Whole-database JSON snapshot, written to backups/.
 *
 * pg_dump is not installed on the machines this repo is worked from, so the
 * snapshot goes through Prisma instead: every model the client exposes, dumped
 * in dependency order so the file can be replayed top to bottom.
 *
 * Run from backend/:
 *   DATABASE_URL=... npx ts-node prisma/backup-db.ts
 *   DATABASE_URL=... npx ts-node prisma/backup-db.ts --only DailySafetyEntry
 *
 * BigInt and Date are stringified on the way out; a restore has to cast them
 * back, which is the price of not having pg_dump.
 */
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

/**
 * Parents before children, so a replay never inserts a row whose foreign key
 * has not landed yet.
 */
const MODELS = [
  'organization',
  'site',
  'vendor',
  'designation',
  'user',
  'passwordReset',
  'userSiteScope',
  'device',
  'worker',
  'workerSiteAssignment',
  'workerCredential',
  'shift',
  'siteSettings',
  'attendanceTap',
  'attendanceSession',
  'manualAttendanceRequest',
  'correctionRequest',
  'correctionItem',
  'auditLog',
  'syncBatch',
  'syncEvent',
  'refreshToken',
  'sosEvent',
  'notification',
  'pushToken',
  'dailySafetyEntry',
  'companyDocument',
  'reportJob',
] as const;

/**
 * Left out on purpose: photoBlob holds the Aadhaar and face images, which are
 * large and encrypted, and would turn a readable snapshot into hundreds of
 * megabytes of base64. Back those up with a real pg_dump if they matter.
 */
const EXCLUDED = ['photoBlob'];

async function main() {
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

  const client = prisma as unknown as Record<string, { findMany?: () => Promise<unknown[]> }>;
  const dump: Record<string, unknown[]> = {};
  const skipped: string[] = [];

  for (const model of MODELS) {
    if (only && model.toLowerCase() !== only.toLowerCase()) continue;
    const delegate = client[model];
    // A model renamed since this list was written must be loud, not silent —
    // a backup that quietly skips a table is worse than no backup.
    if (!delegate?.findMany) {
      skipped.push(model);
      continue;
    }
    const rows = await delegate.findMany();
    dump[model] = rows;
    console.log(`${model}: ${rows.length}`);
  }

  if (skipped.length) {
    console.warn(`\nWARNING — no such model, nothing backed up: ${skipped.join(', ')}`);
  }
  console.log(`Excluded by design: ${EXCLUDED.join(', ')}`);

  const dir = join(__dirname, '..', '..', 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(dir, `clams-backup-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(dump, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
  console.log(`\nWrote ${file}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
