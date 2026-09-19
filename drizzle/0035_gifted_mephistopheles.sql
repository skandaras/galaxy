CREATE TABLE `forge_epics` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`repo_url` text NOT NULL,
	`repo_name` text DEFAULT '' NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`integration_branch` text NOT NULL,
	`state` text DEFAULT 'drafting' NOT NULL,
	`state_reason` text DEFAULT '' NOT NULL,
	`charter_doc_id` text,
	`board_id` text,
	`standing_checks` text,
	`gate_checks` text,
	`acceptance` text,
	`max_usd_override` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`approved_at` integer,
	`finished_at` integer,
	`last_step_at` integer
);
--> statement-breakpoint
CREATE INDEX `forge_epics_owner_idx` ON `forge_epics` (`owner_id`);--> statement-breakpoint
CREATE INDEX `forge_epics_due_idx` ON `forge_epics` (`state`,`last_step_at`);--> statement-breakpoint
CREATE TABLE `forge_gate_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`epic_id` text NOT NULL,
	`scope` text NOT NULL,
	`target_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`baseline` integer DEFAULT false NOT NULL,
	`results` text,
	`passed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `forge_gate_runs_target_idx` ON `forge_gate_runs` (`target_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `forge_sprints` (
	`id` text PRIMARY KEY NOT NULL,
	`epic_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'outlined' NOT NULL,
	`record_doc_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `forge_sprints_epic_idx` ON `forge_sprints` (`epic_id`,`position`);--> statement-breakpoint
CREATE TABLE `forge_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`epic_id` text NOT NULL,
	`sprint_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`intent` text DEFAULT '' NOT NULL,
	`acceptance` text DEFAULT '' NOT NULL,
	`checks` text,
	`no_check_reason` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'planned' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`chat_id` text,
	`branch` text DEFAULT '' NOT NULL,
	`record_doc_id` text,
	`card_id` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `forge_tasks_sprint_idx` ON `forge_tasks` (`sprint_id`,`position`);--> statement-breakpoint
CREATE INDEX `forge_tasks_epic_state_idx` ON `forge_tasks` (`epic_id`,`state`);