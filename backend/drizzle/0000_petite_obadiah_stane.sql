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
	`state` text DEFAULT 'OPEN' NOT NULL,
	`worked_minutes` integer,
	`overtime_minutes` integer,
	`late_minutes` integer,
	`early_leave_minutes` integer,
	`logout_site_id` text,
	`is_cross_site` integer DEFAULT false NOT NULL,
	`closed_reason` text,
	`forgot_logout_notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_sessions_login_tap_id_key` ON `attendance_sessions` (`login_tap_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_sessions_logout_tap_id_key` ON `attendance_sessions` (`logout_tap_id`);--> statement-breakpoint
CREATE INDEX `ix_sessions_worker_day` ON `attendance_sessions` (`worker_id`,`work_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_open_session_per_worker` ON `attendance_sessions` (`worker_id`) WHERE state = 'OPEN';--> statement-breakpoint
CREATE TABLE `correction_items` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`field` text NOT NULL,
	`proposed_value` text NOT NULL,
	`previous_value` text,
	FOREIGN KEY (`request_id`) REFERENCES `correction_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_correction_items_request` ON `correction_items` (`request_id`);--> statement-breakpoint
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
	`status` text DEFAULT 'PENDING' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_notes` text,
	`auto_applied` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_corrections_status_org` ON `correction_requests` (`status`,`organization_id`);--> statement-breakpoint
CREATE INDEX `ix_corrections_org_applied` ON `correction_requests` (`organization_id`,`auto_applied`,`created_at`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`is_overnight` integer DEFAULT false NOT NULL,
	`late_grace_minutes` integer DEFAULT 0 NOT NULL,
	`early_grace_minutes` integer DEFAULT 0 NOT NULL,
	`ot_threshold_minutes` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`site_id` text PRIMARY KEY NOT NULL,
	`verification_mode` text DEFAULT 'MANUAL' NOT NULL,
	`auto_login_countdown_seconds` integer DEFAULT 10 NOT NULL,
	`duplicate_tap_cooldown_seconds` integer DEFAULT 30 NOT NULL,
	`safety_gap_minutes` integer DEFAULT 10 NOT NULL,
	`geo_enforcement` integer DEFAULT false NOT NULL,
	`geo_radius_meters` integer DEFAULT 200 NOT NULL,
	`photo_verification_mode` text DEFAULT 'RANDOM' NOT NULL,
	`photo_verification_random_pct` integer DEFAULT 20 NOT NULL,
	`default_shift_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`latitude` real,
	`longitude` real,
	`geofence_radius_m` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_organization_id_code_key` ON `sites` (`organization_id`,`code`);