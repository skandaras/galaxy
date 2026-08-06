CREATE TABLE `board_lanes` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `board_lanes_board_idx` ON `board_lanes` (`board_id`,`position`);--> statement-breakpoint
CREATE TABLE `board_members` (
	`board_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'collaborator' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`board_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `board_members_user_idx` ON `board_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `board_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`colour` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`is_done` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `board_statuses_board_idx` ON `board_statuses` (`board_id`,`position`);--> statement-breakpoint
CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `boards_owner_idx` ON `boards` (`owner_id`);--> statement-breakpoint
CREATE TABLE `card_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`kind` text DEFAULT 'document' NOT NULL,
	`extracted_text` text,
	`text_chars` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `card_attachments_card_idx` ON `card_attachments` (`card_id`);--> statement-breakpoint
CREATE TABLE `card_log` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`actor` text DEFAULT 'user' NOT NULL,
	`user_id` text,
	`event` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `card_log_card_created_idx` ON `card_log` (`card_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`lane_id` text NOT NULL,
	`status_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'none' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`assigned_to` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cards_board_lane_idx` ON `cards` (`board_id`,`lane_id`,`position`);--> statement-breakpoint
CREATE INDEX `cards_board_archived_idx` ON `cards` (`board_id`,`archived_at`);