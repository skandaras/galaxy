ALTER TABLE `models` ADD `supports_reasoning` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `reasoning_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_log` ADD `reasoning_tokens` integer DEFAULT 0 NOT NULL;