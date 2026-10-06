CREATE TABLE `memory_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`item_id` text,
	`kind` text,
	`title` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `memory_proposals_user_status_idx` ON `memory_proposals` (`user_id`,`status`);--> statement-breakpoint
ALTER TABLE `memory_items` ADD `title` text DEFAULT '' NOT NULL;