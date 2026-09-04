-- Schema that exists in production but was never written down as a migration.
--
-- Four tables, three tables' worth of columns and an enum were created directly
-- against the running database — `db push`, or by hand — so the migration
-- history has never described them. That is invisible until someone builds a
-- database from the migrations alone: it comes up short and fails on the first
-- photo upload, the first worker with a designation, and the first
-- forgot-logout sweep.
--
-- Everything here is additive and guarded, so an environment that already has
-- these is untouched and this is safe to run anywhere.
--
-- What is deliberately NOT here: `migrate diff` also proposed dropping
-- ix_workers_code and ix_workers_name_trgm, dropping the default on
-- push_tokens.updated_at, and recreating three foreign keys with different
-- delete rules. Those indexes exist only in raw SQL and are what make worker
-- search fast; the rest is drift the running system depends on. Skipped, not
-- "corrected" — matching schema.prisma is not worth degrading a live system.

-- CreateEnum ---------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PersonCategory') THEN
    CREATE TYPE "PersonCategory" AS ENUM ('WORKER', 'STAFF', 'VISITOR');
  END IF;
END
$$;

-- Columns ------------------------------------------------------------------

-- The claim guard the forgot-logout monitor writes to. Without it every replica
-- re-alerts on the same open session.
ALTER TABLE "attendance_sessions"
  ADD COLUMN IF NOT EXISTS "forgot_logout_notified_at" TIMESTAMPTZ;

-- Company profile, printed on ID cards.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "address_line1" TEXT,
  ADD COLUMN IF NOT EXISTS "address_line2" TEXT,
  ADD COLUMN IF NOT EXISTS "city" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "logo_url" TEXT,
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "pincode" TEXT,
  ADD COLUMN IF NOT EXISTS "state" TEXT,
  ADD COLUMN IF NOT EXISTS "website" TEXT;

-- Worker/staff/visitor split, designation, and the encrypted identity fields.
ALTER TABLE "workers"
  ADD COLUMN IF NOT EXISTS "aadhaar_back_photo_id" UUID,
  ADD COLUMN IF NOT EXISTS "aadhaar_front_photo_id" UUID,
  ADD COLUMN IF NOT EXISTS "bank_account_ciphertext" BYTEA,
  ADD COLUMN IF NOT EXISTS "bank_account_last4" TEXT,
  ADD COLUMN IF NOT EXISTS "category" "PersonCategory" NOT NULL DEFAULT 'WORKER',
  ADD COLUMN IF NOT EXISTS "created_by_id" UUID,
  ADD COLUMN IF NOT EXISTS "designation_id" UUID,
  ADD COLUMN IF NOT EXISTS "pan_ciphertext" BYTEA,
  ADD COLUMN IF NOT EXISTS "pan_last4" TEXT,
  ADD COLUMN IF NOT EXISTS "updated_by_id" UUID;

-- Tables -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "designations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "designations_pkey" PRIMARY KEY ("id")
);

-- `data` is NOT NULL here and becomes nullable in the next migration, when the
-- bytes move to object storage. Kept in that order so this file stays a true
-- record of what production looked like.
CREATE TABLE IF NOT EXISTS "photo_blobs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mime_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "kind" "PhotoKind" NOT NULL DEFAULT 'PROFILE',
    "is_compressed" BOOLEAN NOT NULL DEFAULT false,
    "is_encrypted" BOOLEAN NOT NULL DEFAULT false,
    "original_size_bytes" INTEGER,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_blobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "sos_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "site_id" UUID,
    "site_name" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geo_accuracy_m" DOUBLE PRECISION,
    "device_uid" TEXT,
    "device_name" TEXT,
    "sender_name" TEXT,
    "sender_role" TEXT,
    "sender_email" TEXT,
    "message" TEXT,
    "acknowledged_by" UUID,
    "acknowledged_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sos_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "site_id" UUID,
    "data" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ,
    "read_by" UUID,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- Indexes ------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "designations_organization_id_name_key"
  ON "designations"("organization_id", "name");

CREATE INDEX IF NOT EXISTS "sos_events_organization_id_created_at_idx"
  ON "sos_events"("organization_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "notifications_organization_id_created_at_idx"
  ON "notifications"("organization_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "workers_organization_id_category_idx"
  ON "workers"("organization_id", "category");

-- Foreign keys -------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workers_designation_id_fkey'
  ) THEN
    ALTER TABLE "workers"
      ADD CONSTRAINT "workers_designation_id_fkey"
      FOREIGN KEY ("designation_id") REFERENCES "designations"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
