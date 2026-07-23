CREATE TABLE `memory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`source` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`triggers` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
