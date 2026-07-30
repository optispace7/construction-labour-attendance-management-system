-- The safety board gets a table of its own.
--
-- One row per site, per day, per metric. Tall rather than twenty-one columns
-- because the brief asks for Edit / Delete / View on each individual item across
-- every date — a row operation here, a partial-column update in the wide shape —
-- and because a further metric then costs an enum value instead of a migration.
--
-- DAILY_MANPOWER, TOTAL_MANPOWER and TOTAL_SAFE_MAN_HOURS are derived from
-- attendance and leave "value" null; they exist as rows only so the Safety
-- Officer can attach a comment to them. Nothing caches a manpower figure that
-- attendance could change underneath it.
--
-- Additive only: a new enum, a new table, no existing column touched, so the old
-- image keeps running against this schema during the rollout.

CREATE TYPE "SafetyMetric" AS ENUM (
    'DAILY_MANPOWER',
    'TOTAL_MANPOWER',
    'TOTAL_SAFE_MAN_HOURS',
    'LABOUR_INDUCTION',
    'TOOLBOX_TALK',
    'WORK_PERMIT',
    'UNSAFE_ACTS',
    'UNSAFE_CONDITIONS',
    'UNSAFE_ACTS_CLOSED',
    'UNSAFE_CONDITIONS_CLOSED',
    'SAFETY_OBSERVATION',
    'SAFETY_OBSERVATION_CLOSED',
    'NEAR_MISS',
    'FIRST_AID',
    'MEDICAL_TREATMENT_CASE',
    'LOST_TIME_INJURY',
    'SAFETY_INSPECTION',
    'WASTE_DISPOSAL',
    'VISITOR_INDUCTION',
    'SAFETY_AUDIT',
    'TRAINING'
);

CREATE TABLE "daily_safety_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "entry_date" DATE NOT NULL,
    "metric" "SafetyMetric" NOT NULL,
    "value" INTEGER,
    "comment" TEXT,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "daily_safety_entries_pkey" PRIMARY KEY ("id")
);

-- One value per metric per site per day. The upsert on the daily form relies on
-- this being the conflict target.
CREATE UNIQUE INDEX "daily_safety_entries_site_id_entry_date_metric_key"
    ON "daily_safety_entries"("site_id", "entry_date", "metric");

-- The statistics page always filters an org by a date window, then optionally
-- narrows to one site.
CREATE INDEX "daily_safety_entries_organization_id_entry_date_idx"
    ON "daily_safety_entries"("organization_id", "entry_date");

ALTER TABLE "daily_safety_entries"
    ADD CONSTRAINT "daily_safety_entries_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
