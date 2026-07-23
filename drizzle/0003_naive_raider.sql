CREATE TABLE `code_sessions` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`repo_url` text NOT NULL,
	`repo_name` text NOT NULL,
	`base_branch` text NOT NULL,
	`work_branch` text NOT NULL,
	`workspace_rel` text NOT NULL,
	`mode` text DEFAULT 'plan' NOT NULL,
	`created_at` integer NOT NULL
);
