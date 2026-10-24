ALTER TABLE `usine_loop_items` RENAME COLUMN `held_by_run_id` TO `suppressed_by_run_id`;--> statement-breakpoint
ALTER TABLE `usine_loop_items` RENAME COLUMN `held_event_id` TO `suppressed_event_id`;