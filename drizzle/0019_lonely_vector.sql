CREATE TABLE `alignment_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`constitution_version_id` text NOT NULL,
	`rubric_version` integer DEFAULT 1 NOT NULL,
	`entry_hash` text NOT NULL,
	`band` text DEFAULT 'insufficient' NOT NULL,
	`standing` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`confidence` text DEFAULT 'low' NOT NULL,
	`scores` text,
	`tensions` text,
	`gaps` text,
	`disengagement` text,
	`rumination` integer DEFAULT false NOT NULL,
	`care` integer DEFAULT false NOT NULL,
	`next_step` text DEFAULT '' NOT NULL,
	`question` text DEFAULT '' NOT NULL,
	`model_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alignment_assessments_user_created_idx` ON `alignment_assessments` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alignment_assessments_entry_idx` ON `alignment_assessments` (`entry_id`);--> statement-breakpoint
CREATE TABLE `alignment_constitution_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alignment_versions_user_created_idx` ON `alignment_constitution_versions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `alignment_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`mood` integer,
	`tags` text DEFAULT '' NOT NULL,
	`skip_assessment` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alignment_entries_user_created_idx` ON `alignment_entries` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `alignment_principle_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`principle_id` text NOT NULL,
	`user_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`changed_fields` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alignment_revisions_principle_idx` ON `alignment_principle_revisions` (`principle_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `alignment_principle_tensions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`a_id` text NOT NULL,
	`b_id` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alignment_tensions_user_idx` ON `alignment_principle_tensions` (`user_id`);--> statement-breakpoint
CREATE TABLE `alignment_principles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'value' NOT NULL,
	`title` text NOT NULL,
	`statement` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`exemplar` text DEFAULT '' NOT NULL,
	`counter_exemplar` text DEFAULT '' NOT NULL,
	`weight` integer DEFAULT 3 NOT NULL,
	`conviction` integer DEFAULT 3 NOT NULL,
	`origin` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`review_after` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alignment_principles_user_status_idx` ON `alignment_principles` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `alignment_syntheses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`highlights` text,
	`neglected` text,
	`model_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alignment_syntheses_user_created_idx` ON `alignment_syntheses` (`user_id`,`created_at`);