-- Per-user memory. Existing memories were global and cannot be attributed to an
-- owner after the fact, so they are cleared rather than mis-assigned; each
-- user's memory regenerates from their own activity on the next audit.
-- This DELETE is deliberate, is scoped to memory_items alone, and is the only
-- destructive statement in the migration history. It must never be widened.
DELETE FROM `memory_items`;--> statement-breakpoint
ALTER TABLE `memory_items` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `skill_candidates` ADD `user_id` text;