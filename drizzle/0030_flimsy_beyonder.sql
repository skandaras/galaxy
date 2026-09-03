CREATE INDEX `cards_lane_idx` ON `cards` (`lane_id`);--> statement-breakpoint
CREATE INDEX `cards_status_idx` ON `cards` (`status_id`);--> statement-breakpoint
CREATE INDEX `cards_project_idx` ON `cards` (`project_id`);--> statement-breakpoint
CREATE INDEX `cortex_change_log_created_idx` ON `cortex_change_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `mcp_tools_server_idx` ON `mcp_tools` (`server_id`);--> statement-breakpoint
CREATE INDEX `ux_ideas_created_idx` ON `ux_ideas` (`created_at`);