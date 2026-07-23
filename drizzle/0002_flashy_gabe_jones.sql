CREATE TABLE `task_prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`system_prompt` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL
);
