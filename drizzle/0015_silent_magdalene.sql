CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`link` text DEFAULT '' NOT NULL,
	`entity_id` text,
	`urgent` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE INDEX `notifications_user_read_idx` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_user_created_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_entity_idx` ON `notifications` (`entity_id`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);