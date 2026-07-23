CREATE TABLE `library_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`author` text DEFAULT 'user' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`triggers` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`author` text DEFAULT 'user' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_unique` ON `skills` (`name`);