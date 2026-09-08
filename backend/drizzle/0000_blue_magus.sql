CREATE TABLE `attendance_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`site_id` text NOT NULL,
	`shift_id` text,
	`work_date` text NOT NULL,
	`login_tap_id` text,
	`logout_tap_id` text,
	`login_at` integer NOT NULL,
	`logout_at` integer,
	`state` text NOT NULL,
	`worked_minutes` integer,
	`overtime_minutes` integer,
	`late_minutes` integer,
	`early_leave_minutes` integer,
	`logout_site_id` text,
	`is_cross_site` integer NOT NULL,
	`closed_reason` text,
	`forgot_logout_notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_sessions_login_tap_id_unique` ON `attendance_sessions` (`login_tap_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_sessions_logout_tap_id_unique` ON `attendance_sessions` (`logout_tap_id`);--> statement-breakpoint
CREATE TABLE `attendance_taps` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`site_id` text NOT NULL,
	`device_id` text,
	`device_label` text,
	`worker_id` text,
	`raw_identifier` text,
	`tap_source` text NOT NULL,
	`tap_type` text,
	`client_event_time` integer NOT NULL,
	`server_received_at` integer NOT NULL,
	`monotonic_ms` integer,
	`latitude` real,
	`longitude` real,
	`geo_accuracy_m` real,
	`verified_mode` text,
	`photo_captured_url` text,
	`is_manual_backup` integer NOT NULL,
	`manual_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY NOT NULL,
	`organization_id` text,
	`actor_user_id` text,
	`actor_role` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`old_value` text,
	`new_value` text,
	`reason` text,
	`ip_address` text,
	`device_id` text,
	`request_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`password` text,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_session` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`image` text,
	`username` text,
	`display_username` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `company_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`storage_key` text,
	`data` blob,
	`size_bytes` integer NOT NULL,
	`valid_until` text,
	`remind_days_before` integer NOT NULL,
	`reminder_sent_for` text,
	`expiry_sent_for` text,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `correction_items` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`field` text NOT NULL,
	`proposed_value` text NOT NULL,
	`previous_value` text
);
--> statement-breakpoint
CREATE TABLE `correction_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`site_id` text NOT NULL,
	`session_id` text,
	`work_date` text NOT NULL,
	`type` text NOT NULL,
	`reason` text NOT NULL,
	`notes` text,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_notes` text,
	`auto_applied` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_safety_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`site_id` text NOT NULL,
	`entry_date` text NOT NULL,
	`metric` text NOT NULL,
	`value` integer,
	`comment` text,
	`recorded_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_waste_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`site_id` text NOT NULL,
	`entry_date` text NOT NULL,
	`waste_type_id` text NOT NULL,
	`value` integer NOT NULL,
	`recorded_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `designations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`site_id` text,
	`device_uid` text NOT NULL,
	`label` text,
	`platform` text,
	`user_id` text,
	`status` text NOT NULL,
	`token_hash` text,
	`authorized_by` text,
	`authorized_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `manual_attendance_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`site_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`tap_id` text NOT NULL,
	`tap_type` text NOT NULL,
	`session_id` text,
	`recorded_at` integer NOT NULL,
	`reason` text,
	`device_id` text,
	`status` text NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manual_attendance_requests_tap_id_unique` ON `manual_attendance_requests` (`tap_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`site_id` text,
	`data` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`read_by` text
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`timezone` text NOT NULL,
	`is_active` integer NOT NULL,
	`address_line1` text,
	`address_line2` text,
	`city` text,
	`state` text,
	`pincode` text,
	`phone` text,
	`email` text,
	`website` text,
	`logo_url` text,
	`logo_scale` real NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_code_unique` ON `organizations` (`code`);--> statement-breakpoint
CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`otp_hash` text NOT NULL,
	`reset_token_hash` text,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `photo_blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`mime_type` text NOT NULL,
	`storage_key` text,
	`data` blob,
	`size_bytes` integer NOT NULL,
	`kind` text NOT NULL,
	`is_compressed` integer NOT NULL,
	`is_encrypted` integer NOT NULL,
	`original_size_bytes` integer,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`device_uid` text,
	`token` text NOT NULL,
	`platform` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_tokens_token_unique` ON `push_tokens` (`token`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`family_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`device_id` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`replaced_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `report_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`report_type` text NOT NULL,
	`format` text NOT NULL,
	`params` text NOT NULL,
	`status` text NOT NULL,
	`result_url` text,
	`error` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`is_overnight` integer NOT NULL,
	`late_grace_minutes` integer NOT NULL,
	`early_grace_minutes` integer NOT NULL,
	`ot_threshold_minutes` integer NOT NULL,
	`is_active` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`site_id` text PRIMARY KEY NOT NULL,
	`verification_mode` text NOT NULL,
	`auto_login_countdown_seconds` integer NOT NULL,
	`duplicate_tap_cooldown_seconds` integer NOT NULL,
	`safety_gap_minutes` integer NOT NULL,
	`geo_enforcement` integer NOT NULL,
	`geo_radius_meters` integer NOT NULL,
	`photo_verification_mode` text NOT NULL,
	`photo_verification_random_pct` integer NOT NULL,
	`default_shift_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`timezone` text NOT NULL,
	`latitude` real,
	`longitude` real,
	`geofence_radius_m` integer,
	`is_active` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sos_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`site_id` text,
	`site_name` text,
	`latitude` real,
	`longitude` real,
	`geo_accuracy_m` real,
	`device_uid` text,
	`device_name` text,
	`sender_name` text,
	`sender_role` text,
	`sender_email` text,
	`message` text,
	`acknowledged_by` text,
	`acknowledged_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`event_count` integer NOT NULL,
	`accepted` integer NOT NULL,
	`duplicates` integer NOT NULL,
	`conflicts` integer NOT NULL,
	`rejected` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_events` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`tap_id` text
);
--> statement-breakpoint
CREATE TABLE `user_site_scopes` (
	`user_id` text NOT NULL,
	`site_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`role` text NOT NULL,
	`full_name` text NOT NULL,
	`email` text,
	`username` text,
	`phone` text,
	`password_hash` text,
	`is_active` integer NOT NULL,
	`can_apply_corrections` integer NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`contact_person` text,
	`contact_number` text,
	`is_active` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `waste_types` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer NOT NULL,
	`is_active` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`is_active` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`revoked_at` integer,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `worker_site_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`site_id` text NOT NULL,
	`vendor_id` text,
	`start_date` text NOT NULL,
	`end_date` text,
	`is_primary` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`worker_code` text NOT NULL,
	`nfc_uid` text,
	`qr_identifier` text,
	`full_name` text NOT NULL,
	`father_name` text,
	`gender` text,
	`date_of_birth` text,
	`language` text,
	`photo_url` text,
	`mobile_number` text,
	`email` text,
	`pincode` text,
	`blood_group` text,
	`emergency_contact_name` text,
	`emergency_contact_number` text,
	`screening_done_on` text,
	`screening_done_by` text,
	`induction_done_on` text,
	`inducted_by` text,
	`validity_till` text,
	`nominee_name` text,
	`nominee_relation` text,
	`vendor_id` text,
	`designation_id` text,
	`category` text NOT NULL,
	`nature_of_contractor` text,
	`bank_name` text,
	`bank_account_number` text,
	`bank_account_ciphertext` blob,
	`bank_account_last4` text,
	`ifsc_code` text,
	`pf_number` text,
	`esi_number` text,
	`gov_id_type` text,
	`aadhaar_ciphertext` blob,
	`aadhaar_last4` text,
	`aadhaar_front_photo_id` text,
	`aadhaar_back_photo_id` text,
	`pan_ciphertext` blob,
	`pan_last4` text,
	`escort_name` text,
	`visitor_company` text,
	`id_proof_photo_id` text,
	`status` text NOT NULL,
	`join_date` text,
	`exit_date` text,
	`notes` text,
	`created_by_id` text,
	`updated_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
