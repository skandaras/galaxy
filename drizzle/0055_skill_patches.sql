ALTER TABLE `skill_candidates` ADD `kind` text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE `skill_candidates` ADD `target_skill_id` text;--> statement-breakpoint
ALTER TABLE `skill_candidates` ADD `base_version` integer;--> statement-breakpoint
ALTER TABLE `skill_candidates` ADD `patch` text;