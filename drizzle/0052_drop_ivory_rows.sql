-- Ivory Tower's rows that have nothing on disk behind them. Its skill, its chats and the
-- events they left are removed by removeIvoryTower in bootstrap.ts, which can reach the
-- files those rows point at (the skill row is left for it, because deleteSkill finds the
-- folder through that row) and which repeats all of this on every boot, for an image
-- rolled back to and promoted past again.
DELETE FROM `task_configs` WHERE `task` LIKE 'ivory-%';--> statement-breakpoint
DELETE FROM `task_prompt_versions` WHERE `task` LIKE 'ivory-%';--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('ivory', 'ivory-run', 'ivory-plan');--> statement-breakpoint
DELETE FROM `tool_settings` WHERE `name` IN ('paper_search', 'read_paper', 'shelf_read', 'shelf_write', 'set_status', 'propose_tasks');
