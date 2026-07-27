-- Safety gap: the minimum minutes that must pass before a worker's attendance
-- state can flip again (login -> logout, or logout -> login).
--
-- The 30-second duplicate cooldown only catches a badge re-read a moment later.
-- A watchman working a queue keeps the badge in front of the camera, so the
-- re-read that gets through is the first one AFTER the cooldown expires — and it
-- silently scanned people back out a minute after they arrived.
ALTER TABLE "site_settings" ADD COLUMN "safety_gap_minutes" INTEGER NOT NULL DEFAULT 10;
