ALTER TABLE `library_docs` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `library_docs` ADD `root_id` text;--> statement-breakpoint
CREATE INDEX `library_docs_parent_idx` ON `library_docs` (`parent_id`);--> statement-breakpoint
CREATE INDEX `library_docs_root_idx` ON `library_docs` (`root_id`);--> statement-breakpoint
-- Every existing doc is a root of its own tree. Without this the digest's
-- GROUP BY root_id lands every pre-tree doc in one NULL bucket, which is the
-- opposite of what the column is for. Reads still COALESCE to the id, because
-- a rollback followed by rows the old image wrote leaves nulls behind that this
-- statement has already run past.
UPDATE `library_docs` SET `root_id` = `id` WHERE `root_id` IS NULL;
