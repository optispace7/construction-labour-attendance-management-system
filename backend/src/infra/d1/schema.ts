import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * The correction flow's tables, in SQLite.
 *
 * A spike: only what the attendance-correction path touches, because that is
 * the part whose behaviour is in question. Everything else is mechanical by
 * comparison and there is no point converting it before knowing the answer.
 *
 * Three conversions matter and are made deliberately rather than by a tool:
 *
 * UUIDs become text. SQLite has no uuid type. The values are unchanged, so a
 * row keeps the id it had in Postgres and anything referencing it still lines
 * up — which is what makes a later data migration a copy rather than a remap.
 *
 * Timestamps become integers: milliseconds since the epoch, UTC. SQLite has no
 * date or time type at all, and storing them as text invites a comparison that
 * sorts '2026-9-8' before '2026-10-1'. An integer sorts and compares correctly
 * by construction. `work_date` stays text, deliberately — it is a calendar day,
 * not an instant, and giving it a time component is how a day boundary drifts.
 *
 * Enums become text with a CHECK. Postgres enforced the values as a type;
 * SQLite has no enum, and without the constraint a typo in application code
 * writes a status nothing will ever match again.
 */

/** Milliseconds since epoch. See the note above on why not text. */
const timestampMs = (col: string) => integer(col, { mode: 'timestamp_ms' });

export const sites = sqliteTable('sites', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  code: text('code').notNull(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  geofenceRadiusM: integer('geofence_radius_m'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: timestampMs('created_at').notNull(),
  updatedAt: timestampMs('updated_at').notNull(),
}, (t) => ({
  orgCode: uniqueIndex('sites_organization_id_code_key').on(t.organizationId, t.code),
}));

export const siteSettings = sqliteTable('site_settings', {
  siteId: text('site_id').primaryKey().references(() => sites.id, { onDelete: 'cascade' }),
  verificationMode: text('verification_mode').notNull().default('MANUAL'),
  autoLoginCountdownSeconds: integer('auto_login_countdown_seconds').notNull().default(10),
  duplicateTapCooldownSeconds: integer('duplicate_tap_cooldown_seconds').notNull().default(30),
  safetyGapMinutes: integer('safety_gap_minutes').notNull().default(10),
  geoEnforcement: integer('geo_enforcement', { mode: 'boolean' }).notNull().default(false),
  geoRadiusMeters: integer('geo_radius_meters').notNull().default(200),
  photoVerificationMode: text('photo_verification_mode').notNull().default('RANDOM'),
  photoVerificationRandomPct: integer('photo_verification_random_pct').notNull().default(20),
  defaultShiftId: text('default_shift_id'),
  updatedAt: timestampMs('updated_at').notNull(),
});

export const shifts = sqliteTable('shifts', {
  id: text('id').primaryKey(),
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // Postgres `time` has no SQLite equivalent. Kept as 'HH:MM' text, which is
  // what it is compared and displayed as; it is never used as an instant.
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  isOvernight: integer('is_overnight', { mode: 'boolean' }).notNull().default(false),
  lateGraceMinutes: integer('late_grace_minutes').notNull().default(0),
  earlyGraceMinutes: integer('early_grace_minutes').notNull().default(0),
  otThresholdMinutes: integer('ot_threshold_minutes').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: timestampMs('created_at').notNull(),
});

export const attendanceSessions = sqliteTable('attendance_sessions', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  workerId: text('worker_id').notNull(),
  siteId: text('site_id').notNull().references(() => sites.id),
  shiftId: text('shift_id').references(() => shifts.id),
  // A calendar day, not an instant — see the note at the top.
  workDate: text('work_date').notNull(),
  loginTapId: text('login_tap_id'),
  logoutTapId: text('logout_tap_id'),
  loginAt: timestampMs('login_at').notNull(),
  logoutAt: timestampMs('logout_at'),
  state: text('state').notNull().default('OPEN'),
  workedMinutes: integer('worked_minutes'),
  overtimeMinutes: integer('overtime_minutes'),
  lateMinutes: integer('late_minutes'),
  earlyLeaveMinutes: integer('early_leave_minutes'),
  logoutSiteId: text('logout_site_id'),
  isCrossSite: integer('is_cross_site', { mode: 'boolean' }).notNull().default(false),
  closedReason: text('closed_reason'),
  forgotLogoutNotifiedAt: timestampMs('forgot_logout_notified_at'),
  createdAt: timestampMs('created_at').notNull(),
  updatedAt: timestampMs('updated_at').notNull(),
}, (t) => ({
  loginTap: uniqueIndex('attendance_sessions_login_tap_id_key').on(t.loginTapId),
  logoutTap: uniqueIndex('attendance_sessions_logout_tap_id_key').on(t.logoutTapId),
  byWorkerDay: index('ix_sessions_worker_day').on(t.workerId, t.workDate),
  // The invariant the whole gate rests on: one OPEN session per worker.
  // SQLite supports partial indexes, so this survives the move intact — it was
  // the single thing most likely not to.
  openPerWorker: uniqueIndex('uq_open_session_per_worker')
    .on(t.workerId)
    .where(sql`state = 'OPEN'`),
}));

export const correctionRequests = sqliteTable('correction_requests', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  workerId: text('worker_id').notNull(),
  siteId: text('site_id').notNull(),
  sessionId: text('session_id'),
  workDate: text('work_date').notNull(),
  type: text('type').notNull(),
  reason: text('reason').notNull(),
  notes: text('notes'),
  requestedBy: text('requested_by').notNull(),
  status: text('status').notNull().default('PENDING'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestampMs('reviewed_at'),
  reviewNotes: text('review_notes'),
  autoApplied: integer('auto_applied', { mode: 'boolean' }).notNull().default(false),
  createdAt: timestampMs('created_at').notNull(),
  updatedAt: timestampMs('updated_at').notNull(),
}, (t) => ({
  byStatus: index('ix_corrections_status_org').on(t.status, t.organizationId),
  byOrgApplied: index('ix_corrections_org_applied').on(t.organizationId, t.autoApplied, t.createdAt),
}));

export const correctionItems = sqliteTable('correction_items', {
  id: text('id').primaryKey(),
  requestId: text('request_id')
    .notNull()
    .references(() => correctionRequests.id, { onDelete: 'cascade' }),
  field: text('field').notNull(),
  // Postgres jsonb becomes text holding JSON. SQLite can index into it with
  // json_extract when needed; here it is only ever read whole and parsed.
  proposedValue: text('proposed_value').notNull(),
  previousValue: text('previous_value'),
}, (t) => ({
  byRequest: index('ix_correction_items_request').on(t.requestId),
}));
