-- Memory's settings, per-user state and its one tool's Admin row go with its tables.
DELETE FROM `settings` WHERE `key` = 'memory' OR `key` LIKE 'memory.%';--> statement-breakpoint
DELETE FROM `tool_settings` WHERE `name` = 'memory_read';
