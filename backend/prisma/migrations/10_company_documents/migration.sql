-- Company documents: PDFs the company keeps on file, watched for expiry.
--
-- The bytes live in Postgres alongside the photo blobs rather than in object
-- storage: the same one-backup / one-restore argument that put the Aadhaar
-- images here, and these are a handful of licences per company, not a per-worker
-- cost. They do count against DB_STORAGE_LIMIT_BYTES like everything else, which
-- is why the upload is capped server-side.
--
-- valid_until is a DATE, not a timestamp. A licence expires on a day, not at an
-- instant, and storing the day as UTC midnight is what stamps an Indian date one
-- day early once anything reads it back in a local zone.
--
-- reminder_sent_for / expiry_sent_for hold the validity date each mail went out
-- for, rather than a boolean. Extending the validity therefore re-arms the
-- reminder by itself, and the monitor claims a document by writing the column,
-- so the API and the worker replica never both mail the same reminder.
--
-- Additive only: one new table, nothing existing touched.

CREATE TABLE "company_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "valid_until" DATE,
    "remind_days_before" INTEGER NOT NULL DEFAULT 10,
    "reminder_sent_for" DATE,
    "expiry_sent_for" DATE,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "company_documents_pkey" PRIMARY KEY ("id")
);

-- The expiry monitor sweeps one org's dated documents; the company page lists
-- them soonest-expiry first. Both are this index.
CREATE INDEX "company_documents_organization_id_valid_until_idx"
    ON "company_documents"("organization_id", "valid_until");
