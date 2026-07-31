CREATE TABLE `ux_ideas` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`area` text DEFAULT 'general' NOT NULL,
	`severity` text DEFAULT 'medium' NOT NULL,
	`effort` text DEFAULT 'm' NOT NULL,
	`problem` text DEFAULT '' NOT NULL,
	`proposal` text DEFAULT '' NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `ux_ideas_status_created_idx` ON `ux_ideas` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ux_ideas_fingerprint_idx` ON `ux_ideas` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `attachments_chat_idx` ON `attachments` (`chat_id`);--> statement-breakpoint
CREATE INDEX `chats_user_updated_idx` ON `chats` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `events_ts_idx` ON `events` (`ts`);--> statement-breakpoint
CREATE INDEX `events_user_ts_idx` ON `events` (`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `events_chat_ts_idx` ON `events` (`chat_id`,`ts`);--> statement-breakpoint
CREATE INDEX `jobs_created_idx` ON `jobs` (`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_chat_idx` ON `jobs` (`chat_id`);--> statement-breakpoint
CREATE INDEX `memory_items_user_status_idx` ON `memory_items` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `messages_chat_seq_idx` ON `messages` (`chat_id`,`seq`);--> statement-breakpoint
CREATE INDEX `task_prompt_versions_task_created_idx` ON `task_prompt_versions` (`task`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_log_ts_idx` ON `usage_log` (`ts`);--> statement-breakpoint
CREATE INDEX `usage_log_user_ts_idx` ON `usage_log` (`user_id`,`ts`);