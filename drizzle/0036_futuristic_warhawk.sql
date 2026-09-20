CREATE TABLE `library_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_folders_owner_name_idx` ON `library_folders` (`owner_id`,`name`);