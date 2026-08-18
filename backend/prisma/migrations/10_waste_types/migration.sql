-- Waste disposal stops being one number and becomes a breakdown.
--
-- The daily sheet asked for a single "Waste disposal" count, which tells a
-- client how much went out and nothing about what it was. The count stays where
-- it is — every total, chart and export still reads DailySafetyEntry — and
-- gains a table behind it holding the same day split by type.
--
-- The types are a table rather than an enum because the client adds to them.
-- A new stream is a row they type in, not a release we ship.
--
-- Additive only: two new tables, no existing column touched, so the running
-- image keeps working against this schema through the rollout.

CREATE TABLE "waste_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "waste_types_pkey" PRIMARY KEY ("id")
);

-- Two types with the same name in one organization would be two dropdown
-- entries nobody could tell apart, and the figures would split between them.
CREATE UNIQUE INDEX "waste_types_organization_id_name_key"
    ON "waste_types"("organization_id", "name");

ALTER TABLE "waste_types"
    ADD CONSTRAINT "waste_types_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "daily_waste_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "entry_date" DATE NOT NULL,
    "waste_type_id" UUID NOT NULL,
    "value" INTEGER NOT NULL,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "daily_waste_entries_pkey" PRIMARY KEY ("id")
);

-- One figure per type per site per day; the sheet's save upserts on this.
CREATE UNIQUE INDEX "daily_waste_entries_site_id_entry_date_waste_type_id_key"
    ON "daily_waste_entries"("site_id", "entry_date", "waste_type_id");

CREATE INDEX "daily_waste_entries_organization_id_entry_date_idx"
    ON "daily_waste_entries"("organization_id", "entry_date");

ALTER TABLE "daily_waste_entries"
    ADD CONSTRAINT "daily_waste_entries_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: deleting a type must never silently take a month of
-- recorded figures with it. The API retires a type that has been used instead,
-- and only hard-deletes one nothing has been filed against.
ALTER TABLE "daily_waste_entries"
    ADD CONSTRAINT "daily_waste_entries_waste_type_id_fkey"
    FOREIGN KEY ("waste_type_id") REFERENCES "waste_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The eight streams the client named, for every organization that already
-- exists. New organizations get the same list the first time the sheet is
-- opened, so this is a starting point rather than the only way in.
INSERT INTO "waste_types" ("id", "organization_id", "name", "sort_order", "updated_at")
SELECT gen_random_uuid(), o."id", t."name", t."ord", CURRENT_TIMESTAMP
FROM "organizations" o
CROSS JOIN (VALUES
    ('Civil / Block Waste', 1),
    ('Gypsum Waste', 2),
    ('Wooden Waste', 3),
    ('Paper Waste', 4),
    ('Scrap / Metal Waste', 5),
    ('Hazardous Waste', 6),
    ('Electrical / E-Waste', 7),
    ('Food Waste', 8)
) AS t("name", "ord")
ON CONFLICT ("organization_id", "name") DO NOTHING;
