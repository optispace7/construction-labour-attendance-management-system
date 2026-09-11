import {
  blob,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * The database schema. Edit this by hand.
 *
 * It started as output from tools/prisma-to-drizzle.mjs, and the header used to
 * say not to touch it. That stopped being true when schema.prisma was deleted:
 * there is nothing left to regenerate from, and the generator cannot run.
 *
 * It is worth saying what the generator lost, because it cost a production
 * failure to find out. It emitted `.notNull()` and dropped `@default(...)` for
 * all 46 columns that had one, so a table that used to fill in is_active or
 * status by itself now refuses the insert — "NOT NULL constraint failed:
 * vendors.is_active" reaching the panel as a bare "Internal server error". The
 * defaults below were read back off the old schema in git history.
 *
 * Note where the default lives. D1's tables have no DEFAULT clause — the
 * migration that created them was generated from the same lossy output — so
 * Drizzle supplies the value in the INSERT it builds. Anything writing to this
 * database by raw SQL rather than through these definitions still has to pass
 * the column itself.
 */

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  state: text('state'),
  pincode: text('pincode'),
  phone: text('phone'),
  email: text('email'),
  website: text('website'),
  logoUrl: text('logo_url'),
  logoScale: real('logo_scale').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

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
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_sites_organization_id_code').on(t.organizationId, t.code),
}));

export const vendors = sqliteTable('vendors', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  code: text('code').notNull(),
  contactPerson: text('contact_person'),
  contactNumber: text('contact_number'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_vendors_organization_id_code').on(t.organizationId, t.code),
}));

export const designations = sqliteTable('designations', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_designations_organization_id_name').on(t.organizationId, t.name),
}));

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  role: text('role').notNull(),
  fullName: text('full_name').notNull(),
  email: text('email').unique(),
  username: text('username').unique(),
  phone: text('phone'),
  passwordHash: text('password_hash'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  canApplyCorrections: integer('can_apply_corrections', { mode: 'boolean' }).notNull().default(false),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
});

export const passwordResets = sqliteTable('password_resets', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  otpHash: text('otp_hash').notNull(),
  resetTokenHash: text('reset_token_hash'),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const userSiteScopes = sqliteTable('user_site_scopes', {
  userId: text('user_id').notNull(),
  siteId: text('site_id').notNull(),
});

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  siteId: text('site_id'),
  deviceUid: text('device_uid').notNull(),
  label: text('label'),
  platform: text('platform'),
  userId: text('user_id'),
  status: text('status').notNull().default('PENDING'),
  tokenHash: text('token_hash'),
  authorizedBy: text('authorized_by'),
  authorizedAt: integer('authorized_at', { mode: 'timestamp_ms' }),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_devices_organization_id_device_uid').on(t.organizationId, t.deviceUid),
}));

export const workers = sqliteTable('workers', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  workerCode: text('worker_code').notNull(),
  nfcUid: text('nfc_uid'),
  qrIdentifier: text('qr_identifier'),
  fullName: text('full_name').notNull(),
  fatherName: text('father_name'),
  gender: text('gender'),
  dateOfBirth: text('date_of_birth'),
  language: text('language'),
  photoUrl: text('photo_url'),
  mobileNumber: text('mobile_number'),
  email: text('email'),
  pincode: text('pincode'),
  bloodGroup: text('blood_group'),
  emergencyContactName: text('emergency_contact_name'),
  emergencyContactNumber: text('emergency_contact_number'),
  screeningDoneOn: text('screening_done_on'),
  screeningDoneBy: text('screening_done_by'),
  inductionDoneOn: text('induction_done_on'),
  inductedBy: text('inducted_by'),
  validityTill: text('validity_till'),
  nomineeName: text('nominee_name'),
  nomineeRelation: text('nominee_relation'),
  vendorId: text('vendor_id'),
  designationId: text('designation_id'),
  category: text('category').notNull().default('WORKER'),
  natureOfContractor: text('nature_of_contractor'),
  bankName: text('bank_name'),
  bankAccountNumber: text('bank_account_number'),
  bankAccountCiphertext: blob('bank_account_ciphertext', { mode: 'buffer' }),
  bankAccountLast4: text('bank_account_last4'),
  ifscCode: text('ifsc_code'),
  pfNumber: text('pf_number'),
  esiNumber: text('esi_number'),
  govIdType: text('gov_id_type'),
  aadhaarCiphertext: blob('aadhaar_ciphertext', { mode: 'buffer' }),
  aadhaarLast4: text('aadhaar_last4'),
  aadhaarFrontPhotoId: text('aadhaar_front_photo_id'),
  aadhaarBackPhotoId: text('aadhaar_back_photo_id'),
  panCiphertext: blob('pan_ciphertext', { mode: 'buffer' }),
  panLast4: text('pan_last4'),
  escortName: text('escort_name'),
  visitorCompany: text('visitor_company'),
  idProofPhotoId: text('id_proof_photo_id'),
  status: text('status').notNull().default('ACTIVE'),
  joinDate: text('join_date'),
  exitDate: text('exit_date'),
  notes: text('notes'),
  createdById: text('created_by_id'),
  updatedById: text('updated_by_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
}, (t) => ({
  u0: uniqueIndex('uq_workers_organization_id_worker_code').on(t.organizationId, t.workerCode),
}));

export const workerSiteAssignments = sqliteTable('worker_site_assignments', {
  id: text('id').primaryKey(),
  workerId: text('worker_id').notNull(),
  siteId: text('site_id').notNull(),
  vendorId: text('vendor_id'),
  startDate: text('start_date').notNull(),
  endDate: text('end_date'),
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const workerCredentials = sqliteTable('worker_credentials', {
  id: text('id').primaryKey(),
  workerId: text('worker_id').notNull(),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  issuedAt: integer('issued_at', { mode: 'timestamp_ms' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  reason: text('reason'),
});

export const shifts = sqliteTable('shifts', {
  id: text('id').primaryKey(),
  siteId: text('site_id').notNull(),
  name: text('name').notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  isOvernight: integer('is_overnight', { mode: 'boolean' }).notNull().default(false),
  lateGraceMinutes: integer('late_grace_minutes').notNull().default(0),
  earlyGraceMinutes: integer('early_grace_minutes').notNull().default(0),
  otThresholdMinutes: integer('ot_threshold_minutes').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const siteSettings = sqliteTable('site_settings', {
  siteId: text('site_id').primaryKey(),
  verificationMode: text('verification_mode').notNull().default('MANUAL'),
  autoLoginCountdownSeconds: integer('auto_login_countdown_seconds').notNull().default(10),
  duplicateTapCooldownSeconds: integer('duplicate_tap_cooldown_seconds').notNull().default(30),
  safetyGapMinutes: integer('safety_gap_minutes').notNull().default(10),
  geoEnforcement: integer('geo_enforcement', { mode: 'boolean' }).notNull().default(false),
  geoRadiusMeters: integer('geo_radius_meters').notNull().default(200),
  photoVerificationMode: text('photo_verification_mode').notNull().default('RANDOM'),
  photoVerificationRandomPct: integer('photo_verification_random_pct').notNull().default(20),
  defaultShiftId: text('default_shift_id'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const attendanceTaps = sqliteTable('attendance_taps', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull(),
  organizationId: text('organization_id').notNull(),
  siteId: text('site_id').notNull(),
  deviceId: text('device_id'),
  deviceLabel: text('device_label'),
  workerId: text('worker_id'),
  rawIdentifier: text('raw_identifier'),
  tapSource: text('tap_source').notNull(),
  tapType: text('tap_type'),
  clientEventTime: integer('client_event_time', { mode: 'timestamp_ms' }).notNull(),
  serverReceivedAt: integer('server_received_at', { mode: 'timestamp_ms' }).notNull(),
  monotonicMs: integer('monotonic_ms'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  geoAccuracyM: real('geo_accuracy_m'),
  verifiedMode: text('verified_mode'),
  photoCapturedUrl: text('photo_captured_url'),
  isManualBackup: integer('is_manual_backup', { mode: 'boolean' }).notNull().default(false),
  manualReason: text('manual_reason'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_attendance_taps_organization_id_event_id').on(t.organizationId, t.eventId),
}));

export const attendanceSessions = sqliteTable('attendance_sessions', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  workerId: text('worker_id').notNull(),
  siteId: text('site_id').notNull(),
  shiftId: text('shift_id'),
  workDate: text('work_date').notNull(),
  loginTapId: text('login_tap_id').unique(),
  logoutTapId: text('logout_tap_id').unique(),
  loginAt: integer('login_at', { mode: 'timestamp_ms' }).notNull(),
  logoutAt: integer('logout_at', { mode: 'timestamp_ms' }),
  state: text('state').notNull().default('OPEN'),
  workedMinutes: integer('worked_minutes'),
  overtimeMinutes: integer('overtime_minutes'),
  lateMinutes: integer('late_minutes'),
  earlyLeaveMinutes: integer('early_leave_minutes'),
  logoutSiteId: text('logout_site_id'),
  isCrossSite: integer('is_cross_site', { mode: 'boolean' }).notNull().default(false),
  closedReason: text('closed_reason'),
  forgotLogoutNotifiedAt: integer('forgot_logout_notified_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const manualAttendanceRequests = sqliteTable('manual_attendance_requests', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  siteId: text('site_id').notNull(),
  workerId: text('worker_id').notNull(),
  tapId: text('tap_id').notNull().unique(),
  tapType: text('tap_type').notNull(),
  sessionId: text('session_id'),
  recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
  reason: text('reason'),
  deviceId: text('device_id'),
  status: text('status').notNull().default('PENDING'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  reviewNotes: text('review_notes'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

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
  reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  reviewNotes: text('review_notes'),
  autoApplied: integer('auto_applied', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const correctionItems = sqliteTable('correction_items', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  field: text('field').notNull(),
  proposedValue: text('proposed_value').notNull(),
  previousValue: text('previous_value'),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey(),
  organizationId: text('organization_id'),
  actorUserId: text('actor_user_id'),
  actorRole: text('actor_role'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  reason: text('reason'),
  ipAddress: text('ip_address'),
  deviceId: text('device_id'),
  requestId: text('request_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const syncBatches = sqliteTable('sync_batches', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull(),
  receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
  eventCount: integer('event_count').notNull(),
  accepted: integer('accepted').notNull().default(0),
  duplicates: integer('duplicates').notNull().default(0),
  conflicts: integer('conflicts').notNull().default(0),
  rejected: integer('rejected').notNull().default(0),
});

export const syncEvents = sqliteTable('sync_events', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull(),
  eventId: text('event_id').notNull(),
  status: text('status').notNull(),
  detail: text('detail'),
  tapId: text('tap_id'),
});

export const refreshTokens = sqliteTable('refresh_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  familyId: text('family_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  deviceId: text('device_id'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  replacedBy: text('replaced_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const photoBlobs = sqliteTable('photo_blobs', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  mimeType: text('mime_type').notNull(),
  storageKey: text('storage_key'),
  data: blob('data', { mode: 'buffer' }),
  sizeBytes: integer('size_bytes').notNull(),
  kind: text('kind').notNull().default('PROFILE'),
  isCompressed: integer('is_compressed', { mode: 'boolean' }).notNull().default(false),
  isEncrypted: integer('is_encrypted', { mode: 'boolean' }).notNull().default(false),
  originalSizeBytes: integer('original_size_bytes'),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const sosEvents = sqliteTable('sos_events', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  siteId: text('site_id'),
  siteName: text('site_name'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  geoAccuracyM: real('geo_accuracy_m'),
  deviceUid: text('device_uid'),
  deviceName: text('device_name'),
  senderName: text('sender_name'),
  senderRole: text('sender_role'),
  senderEmail: text('sender_email'),
  message: text('message'),
  acknowledgedBy: text('acknowledged_by'),
  acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  siteId: text('site_id'),
  data: text('data'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  readAt: integer('read_at', { mode: 'timestamp_ms' }),
  readBy: text('read_by'),
});

export const pushTokens = sqliteTable('push_tokens', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  userId: text('user_id'),
  deviceUid: text('device_uid'),
  token: text('token').notNull().unique(),
  platform: text('platform'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const dailySafetyEntries = sqliteTable('daily_safety_entries', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  siteId: text('site_id').notNull(),
  entryDate: text('entry_date').notNull(),
  metric: text('metric').notNull(),
  value: integer('value'),
  comment: text('comment'),
  recordedById: text('recorded_by_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_daily_safety_entries_site_id_entry_date_metric').on(t.siteId, t.entryDate, t.metric),
}));

export const wasteTypes = sqliteTable('waste_types', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_waste_types_organization_id_name').on(t.organizationId, t.name),
}));

export const dailyWasteEntries = sqliteTable('daily_waste_entries', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  siteId: text('site_id').notNull(),
  entryDate: text('entry_date').notNull(),
  wasteTypeId: text('waste_type_id').notNull(),
  value: integer('value').notNull(),
  recordedById: text('recorded_by_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_daily_waste_entries_site_id_entry_date_waste_type_id').on(t.siteId, t.entryDate, t.wasteTypeId),
}));

export const companyDocuments = sqliteTable('company_documents', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  siteId: text('site_id').notNull(),
  name: text('name').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  storageKey: text('storage_key'),
  data: blob('data', { mode: 'buffer' }),
  sizeBytes: integer('size_bytes').notNull(),
  validUntil: text('valid_until'),
  remindDaysBefore: integer('remind_days_before').notNull().default(10),
  reminderSentFor: text('reminder_sent_for'),
  expirySentFor: text('expiry_sent_for'),
  uploadedBy: text('uploaded_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const reportJobs = sqliteTable('report_jobs', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  requestedBy: text('requested_by').notNull(),
  reportType: text('report_type').notNull(),
  format: text('format').notNull(),
  params: text('params').notNull(),
  status: text('status').notNull().default('QUEUED'),
  resultUrl: text('result_url'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
});

export const authUser = sqliteTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  username: text('username'),
  displayUsername: text('display_username'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_auth_user_email').on(t.email),
  u1: uniqueIndex('uq_auth_user_username').on(t.username),
}));

export const authSession = sqliteTable('auth_session', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => ({
  u0: uniqueIndex('uq_auth_session_token').on(t.token),
}));

export const authAccount = sqliteTable('auth_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull(),
  password: text('password'),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const authVerification = sqliteTable('auth_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
