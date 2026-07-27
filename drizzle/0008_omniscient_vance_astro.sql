CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text DEFAULT 'http' NOT NULL,
	`url` text,
	`headers_enc` text,
	`command` text,
	`args` text,
	`tool_prefix` text DEFAULT '' NOT NULL,
	`tasks` text,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_error` text,
	`last_sync_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_unique` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE TABLE `mcp_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`name` text NOT NULL,
	`remote_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`parameters` text
);
--> statement-breakpoint
CREATE TABLE `tool_settings` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`description_override` text,
	`tasks` text,
	`updated_at` integer NOT NULL
);
