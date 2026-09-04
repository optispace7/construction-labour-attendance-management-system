-- Company document PDFs move out of Postgres and into object storage.
--
-- Same reasoning as the photos, and more pressing per file: a licence or
-- insurance scan is allowed up to 8 MB, so a dozen of them outweigh every
-- attendance row the system will ever write.
--
-- Backward compatible: `data` becomes nullable rather than being dropped, so
-- documents uploaded before the move keep opening while the backfill runs and
-- while an older deploy is still serving.

ALTER TABLE "company_documents"
  ADD COLUMN IF NOT EXISTS "storage_key" TEXT;

ALTER TABLE "company_documents"
  ALTER COLUMN "data" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "ix_company_documents_storage_key"
  ON "company_documents" ("storage_key")
  WHERE "storage_key" IS NOT NULL;
