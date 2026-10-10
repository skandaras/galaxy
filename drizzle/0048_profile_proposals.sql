CREATE TABLE `profile_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`entry_id` text,
	`path` text,
	`kind` text,
	`claim` text,
	`about` text,
	`until` text,
	`person` text,
	`quote` text,
	`message_id` text,
	`why` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `profile_proposals_user_status_idx` ON `profile_proposals` (`user_id`,`status`);