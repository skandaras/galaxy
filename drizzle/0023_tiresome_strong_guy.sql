CREATE TABLE `cortex_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`node_id` text,
	`target_id` text,
	`payload` text,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `cortex_proposals_user_status_idx` ON `cortex_proposals` (`user_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `cortex_proposals_fingerprint_idx` ON `cortex_proposals` (`fingerprint`);--> statement-breakpoint
ALTER TABLE `cortex_change_log` ADD `run_id` text;--> statement-breakpoint
CREATE INDEX `cortex_change_log_run_idx` ON `cortex_change_log` (`run_id`);