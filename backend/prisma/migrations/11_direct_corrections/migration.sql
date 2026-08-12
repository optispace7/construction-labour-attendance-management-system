-- Let a named person's attendance corrections apply without an approver.
--
-- The client runs one Safety Officer, and wants that officer's fixes to land
-- immediately rather than queue for the Super Admin. The permission is granted
-- per USER, not per role: "there is only one safety officer as of now" is a fact
-- about today, and a role-wide grant would arm the second officer the day they
-- are hired without anyone deciding to.
--
-- Nothing about how a correction is applied changes. The request is still
-- written, still carries its reason, and still goes through the same approval
-- transaction — that path owns the night-shift session lookup, the
-- logout-before-login guard and the hours recompute, and a second write path
-- would have to re-earn all of it. The only difference is who signs it off and
-- when.
--
-- auto_applied marks the ones nobody else reviewed, so the Super Admin has a
-- list to read after the fact. It is stored rather than derived from
-- requested_by = reviewed_by because that equality would also be true of an
-- admin approving their own request under the old rules, and because revoking
-- the permission later must not rewrite what the history says happened.
--
-- Additive only: two columns with defaults and one index, so the running image
-- keeps working against this schema during the rollout.

ALTER TABLE "users"
    ADD COLUMN "can_apply_corrections" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "correction_requests"
    ADD COLUMN "auto_applied" BOOLEAN NOT NULL DEFAULT false;

-- The Super Admin's "applied directly" review list: one org, the flagged rows,
-- newest first.
CREATE INDEX "correction_requests_organization_id_auto_applied_created_at_idx"
    ON "correction_requests"("organization_id", "auto_applied", "created_at" DESC);
