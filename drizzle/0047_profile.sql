CREATE TABLE `profile_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`aka` text DEFAULT '[]' NOT NULL,
	`relation` text DEFAULT '' NOT NULL,
	`named` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_entities_user_name_idx` ON `profile_entities` (`user_id`,`name_key`);--> statement-breakpoint
CREATE TABLE `profile_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`domain` text NOT NULL,
	`subdomain` text NOT NULL,
	`about` text,
	`kind` text NOT NULL,
	`claim` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`sensitivity` text DEFAULT 'normal' NOT NULL,
	`source` text NOT NULL,
	`quote` text,
	`message_id` text,
	`expires_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`supersedes` text,
	`created_at` integer NOT NULL,
	`confirmed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `profile_entries_user_status_path_idx` ON `profile_entries` (`user_id`,`status`,`domain`,`subdomain`);--> statement-breakpoint
CREATE TABLE `profile_subdomains` (
	`user_id` text NOT NULL,
	`domain` text NOT NULL,
	`name` text NOT NULL,
	`sensitivity` text DEFAULT 'normal' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `domain`, `name`)
);
