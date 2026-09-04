-- Photo bytes move out of Postgres and into object storage.
--
-- The row stays: it holds the organization_id that scopes every read, and the
-- byte counts the storage report is built from. Only the payload moves.
--
-- Backward compatible on purpose. `data` becomes nullable rather than being
-- dropped, so rows written before the move keep serving while the backfill
-- runs and while an older deploy is still live. Dropping the column is a
-- separate migration, once nothing reads it.

ALTER TABLE "photo_blobs"
  ADD COLUMN IF NOT EXISTS "storage_key" TEXT;

ALTER TABLE "photo_blobs"
  ALTER COLUMN "data" DROP NOT NULL;

-- Finds rows still awaiting backfill, and is the index the deletion path uses
-- to resolve a key before removing the object.
CREATE INDEX IF NOT EXISTS "ix_photo_blobs_storage_key"
  ON "photo_blobs" ("storage_key")
  WHERE "storage_key" IS NOT NULL;
