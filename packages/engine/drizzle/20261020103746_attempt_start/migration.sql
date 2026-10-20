ALTER TABLE `usine_attempts` ADD `start_json` text;--> statement-breakpoint
ALTER TABLE `usine_attempts` ADD `reattached_at` text;--> statement-breakpoint
ALTER TABLE `usine_runs` ADD `next_start_json` text;--> statement-breakpoint
-- A Run's first Attempt always began from its Event; later ones stay unknown.
UPDATE `usine_attempts` SET `start_json` = '{"_tag":"Event"}' WHERE `attempt_number` = 1;
