-- Manual punches now wait for a Safety Officer.
--
-- Typing a worker code is the one way into attendance with no badge behind it.
-- Until now it opened or closed a session immediately, with nothing but an audit
-- row afterwards. It now files a request instead: the tap is still persisted as
-- evidence, but the session only moves when someone with review rights accepts.

CREATE TYPE "ManualApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "manual_attendance_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "tap_id" UUID NOT NULL,
    "tap_type" "TapType" NOT NULL,
    "session_id" UUID,
    "recorded_at" TIMESTAMPTZ NOT NULL,
    "reason" TEXT,
    "device_id" UUID,
    "status" "ManualApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "review_notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "manual_attendance_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "manual_attendance_requests_tap_id_key"
    ON "manual_attendance_requests"("tap_id");
CREATE INDEX "manual_attendance_requests_organization_id_status_idx"
    ON "manual_attendance_requests"("organization_id", "status");
CREATE INDEX "manual_attendance_requests_worker_id_status_idx"
    ON "manual_attendance_requests"("worker_id", "status");

ALTER TABLE "manual_attendance_requests"
    ADD CONSTRAINT "manual_attendance_requests_worker_id_fkey"
    FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_attendance_requests"
    ADD CONSTRAINT "manual_attendance_requests_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_attendance_requests"
    ADD CONSTRAINT "manual_attendance_requests_tap_id_fkey"
    FOREIGN KEY ("tap_id") REFERENCES "attendance_taps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_attendance_requests"
    ADD CONSTRAINT "manual_attendance_requests_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "attendance_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One pending request per worker. A second manual punch for someone already
-- awaiting review is a mistake at the gate, not a queue: the watchman is told
-- the first one is still waiting rather than filing another. Partial unique
-- indexes have no Prisma equivalent, so this lives only here.
CREATE UNIQUE INDEX "uq_pending_manual_request_per_worker"
    ON "manual_attendance_requests"("worker_id")
    WHERE "status" = 'PENDING';
