ALTER TABLE `skill_candidates` ADD `tasks` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `skills` ADD `tasks` text DEFAULT '' NOT NULL;