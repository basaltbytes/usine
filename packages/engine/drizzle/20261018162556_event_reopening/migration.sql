CREATE TABLE `usine_loop_items` (
	`loop_name` text NOT NULL,
	`item_key` text NOT NULL,
	`observed_event_id` text,
	CONSTRAINT `usine_loop_items_pk` PRIMARY KEY(`loop_name`, `item_key`),
	CONSTRAINT `fk_usine_loop_items_observed_event_id_usine_events_event_id_fk` FOREIGN KEY (`observed_event_id`) REFERENCES `usine_events`(`event_id`)
);
--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `reopens_event_id` text REFERENCES usine_events(event_id);--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `reopening` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `usine_trigger_event_reopening` ON `usine_trigger_events` (`reopens_event_id`,`reopening`);