DROP TABLE IF EXISTS `cortex_fts`;--> statement-breakpoint
DELETE FROM `task_configs` WHERE `task` = 'cortex-groom';--> statement-breakpoint
DELETE FROM `task_prompt_versions` WHERE `task` = 'cortex-groom';--> statement-breakpoint
DELETE FROM `tool_settings` WHERE `name` IN ('cortex_query', 'cortex_write');--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('cortex', 'cortexGroom') OR `key` LIKE 'cortex.%';--> statement-breakpoint
UPDATE `settings` SET `value` = json_remove(`value`, '$.cortexChangeDays') WHERE `key` = 'retention' AND json_valid(`value`);
