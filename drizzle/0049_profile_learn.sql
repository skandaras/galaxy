-- The learning job leaves the memory task for one of its own. Its model is
-- carried across; the memory task's prompt override is not, because it says
-- to leave facts out and would make the new job propose nothing.
INSERT OR IGNORE INTO `task_configs` (`task`, `system_prompt`, `prompt_override`, `primary_model_id`, `backup_model_id`, `options`)
	SELECT 'profile-learn', '', NULL, `primary_model_id`, `backup_model_id`, `options` FROM `task_configs` WHERE `task` = 'memory';--> statement-breakpoint
DELETE FROM `task_configs` WHERE `task` = 'memory';--> statement-breakpoint
DELETE FROM `task_prompt_versions` WHERE `task` = 'memory';--> statement-breakpoint
-- Its schedule moves to the Profile's settings; Memory keeps only its ceiling,
-- which still bounds approving what was already waiting.
INSERT OR IGNORE INTO `settings` (`scope`, `key`, `value`, `updated_at`)
	SELECT 'global', 'profile', json_object(
		'enabled', json(CASE WHEN json_extract(`value`, '$.enabled') = 0 THEN 'false' ELSE 'true' END),
		'intervalHours', coalesce(json_extract(`value`, '$.intervalHours'), 12),
		'timeoutSeconds', coalesce(json_extract(`value`, '$.timeoutSeconds'), 180),
		'briefChars', 2400
	), `updated_at` FROM `settings` WHERE `scope` = 'global' AND `key` = 'memory' AND json_valid(`value`);--> statement-breakpoint
UPDATE `settings` SET `value` = json_remove(`value`, '$.enabled', '$.intervalHours', '$.timeoutSeconds') WHERE `scope` = 'global' AND `key` = 'memory' AND json_valid(`value`);--> statement-breakpoint
-- Someone who turned memory off has said they do not want to be learnt from.
INSERT OR IGNORE INTO `settings` (`scope`, `key`, `value`, `updated_at`)
	SELECT `scope`, 'profile.learn', 'false', `updated_at` FROM `settings` WHERE `key` = 'memory.userEnabled' AND `value` = 'false';--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('memory.watermark', 'memory.lastRun', 'memory.userEnabled', 'memory.rebuild');
