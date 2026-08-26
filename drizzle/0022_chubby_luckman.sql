CREATE TABLE `cortex_associations` (
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`weight` real DEFAULT 0.5 NOT NULL,
	`context_tags` text,
	`description` text DEFAULT '' NOT NULL,
	`directionality` text DEFAULT 'symmetric' NOT NULL,
	`created_at` integer NOT NULL,
	`last_traversed_at` integer,
	`traversal_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`source_id`, `target_id`),
	FOREIGN KEY (`source_id`) REFERENCES `cortex_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `cortex_nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cortex_assoc_target_idx` ON `cortex_associations` (`target_id`);--> statement-breakpoint
CREATE TABLE `cortex_change_log` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text,
	`actor` text DEFAULT 'user' NOT NULL,
	`user_id` text,
	`event` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`before` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cortex_change_log_node_created_idx` ON `cortex_change_log` (`node_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `cortex_change_log_user_created_idx` ON `cortex_change_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `cortex_circuits` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cortex_circuits_owner_idx` ON `cortex_circuits` (`owner_id`);--> statement-breakpoint
CREATE TABLE `cortex_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`visibility` text DEFAULT 'personal' NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`modalities` text,
	`circuits` text,
	`activation_priority` real DEFAULT 0.5 NOT NULL,
	`is_convergence` integer DEFAULT false NOT NULL,
	`x` real,
	`y` real,
	`z` real,
	`last_verified_at` integer,
	`last_activated_at` integer,
	`activation_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cortex_nodes_owner_idx` ON `cortex_nodes` (`owner_id`,`visibility`);