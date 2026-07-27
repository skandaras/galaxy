ALTER TABLE `attachments` ADD `kind` text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE `attachments` ADD `extracted_text` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `text_chars` integer DEFAULT 0 NOT NULL;