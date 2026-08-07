CREATE TABLE `board_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`colour` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `board_projects_board_idx` ON `board_projects` (`board_id`,`position`);--> statement-breakpoint
ALTER TABLE `cards` ADD `project_id` text;