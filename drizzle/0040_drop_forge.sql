DROP TABLE `forge_epics`;--> statement-breakpoint
DROP TABLE `forge_gate_runs`;--> statement-breakpoint
DROP TABLE `forge_sprints`;--> statement-breakpoint
DROP TABLE `forge_tasks`;--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `coding_only`;--> statement-breakpoint
DELETE FROM `task_configs` WHERE `task` IN ('forge-charter', 'forge-sprint', 'forge-review');--> statement-breakpoint
DELETE FROM `task_prompt_versions` WHERE `task` IN ('forge-charter', 'forge-sprint', 'forge-review');--> statement-breakpoint
DELETE FROM `notifications` WHERE `kind` = 'forge-blocked';--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('forge', 'forge.lastSkip');
