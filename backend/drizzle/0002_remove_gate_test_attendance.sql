-- Removes the login/logout used to test the gate on 9 Sep 2026.
--
-- Worker "test" (W-0341) was scanned in at 18:54 and out at 18:55 — a
-- 44-second session — to check that a tap reached D1. It did, which is why
-- this record exists and why it should not: it counts as a man-day on the
-- safety board and turns up in attendance reports as a real shift.
--
-- Only these three rows. The worker itself is left alone, and so is every
-- other row: the two older workers also named "test" are from July and had no
-- part in this.
--
-- The session goes first. It holds login_tap_id and logout_tap_id, so removing
-- a tap out from under it would leave the row referring to nothing.
--
-- This exists in D1 alone. The test was done through the Workers app, and
-- Azure has no worker with this id at all, so re-running the Azure top-up
-- cannot bring it back.

DELETE FROM attendance_sessions WHERE id = '8a8556a3-c0fd-4519-9630-f187db1b1cf2';
--> statement-breakpoint
DELETE FROM attendance_taps WHERE id IN (
  '0311f25b-111a-4f00-8f99-f2dfea4e2d0e',
  '672b2fa0-617c-48ef-a728-7d7dc4c3b21f'
);
