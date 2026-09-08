-- The compound uniqueness the Prisma schema declared, which the generated D1
-- migration did not carry across.
--
-- prisma-to-drizzle.mjs read columns, not `@@unique` blocks, so every
-- single-column unique survived the move and every multi-column one was lost.
-- They are not decoration: several are what makes an upsert an upsert, and
-- attendance_taps(organization_id, event_id) is what stops a replayed tap from
-- becoming a second punch when two requests race the idempotency check.
--
-- Better Auth's own uniqueness went the same way — it declares email, username
-- and session token as @@unique blocks, and a library that assumes it can look
-- an account up by email should not be the one to discover there are two.
--
-- Names match what the generator now emits, so schema.generated.ts and the
-- database describe the same indexes.
--
-- Verified against production before running: no table holds a duplicate under
-- any of these keys.

CREATE UNIQUE INDEX IF NOT EXISTS uq_sites_organization_id_code
  ON sites (organization_id, code);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendors_organization_id_code
  ON vendors (organization_id, code);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_designations_organization_id_name
  ON designations (organization_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_organization_id_device_uid
  ON devices (organization_id, device_uid);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_workers_organization_id_worker_code
  ON workers (organization_id, worker_code);
--> statement-breakpoint
-- The one the gate depends on.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_taps_organization_id_event_id
  ON attendance_taps (organization_id, event_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_safety_entries_site_id_entry_date_metric
  ON daily_safety_entries (site_id, entry_date, metric);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_waste_types_organization_id_name
  ON waste_types (organization_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_waste_entries_site_id_entry_date_waste_type_id
  ON daily_waste_entries (site_id, entry_date, waste_type_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_user_email
  ON auth_user (email);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_user_username
  ON auth_user (username);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_session_token
  ON auth_session (token);
--> statement-breakpoint
-- The first pass used shorter, hand-picked names. Dropped so the database and
-- the generated schema describe one set of indexes rather than two.
DROP INDEX IF EXISTS uq_sites_org_code;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_vendors_org_code;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_designations_org_name;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_devices_org_uid;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_workers_org_code;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_taps_org_event;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_safety_site_date_metric;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_waste_types_org_name;
--> statement-breakpoint
DROP INDEX IF EXISTS uq_waste_site_date_type;
