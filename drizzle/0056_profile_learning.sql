ALTER TABLE `profile_proposals` ADD `basis` text;--> statement-breakpoint
ALTER TABLE `profile_proposals` ADD `applied_entry_id` text;--> statement-breakpoint
-- The yearly "still true?" question is gone, and with it the rows that asked.
DELETE FROM `profile_proposals` WHERE `action` = 'confirm';--> statement-breakpoint
-- Until now an inferred entry was one the person read and approved, line by
-- line. From here `inferred` means nobody was asked and the entry lapses when
-- nothing bears it out, which would retire lines a person signed off.
UPDATE `profile_entries` SET `source` = 'stated' WHERE `source` = 'inferred';--> statement-breakpoint
-- Goals and projects now lapse 180 days after they were last borne out.
-- Without this, every one older than that would go on the first sweep.
UPDATE `profile_entries` SET `confirmed_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE `status` = 'active';
