ALTER TABLE `library_docs` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `library_docs` ADD `visibility` text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
CREATE INDEX `library_docs_owner_idx` ON `library_docs` (`owner_id`,`visibility`);--> statement-breakpoint
ALTER TABLE `users` ADD `can_code` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Everyone who already had an account keeps coding access; the column default
-- is off, so only users provisioned from here on start without it.
UPDATE `users` SET `can_code` = 1;
