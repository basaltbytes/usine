CREATE TABLE `usine_cycle_reservations` (
	`run_id` text PRIMARY KEY,
	`item_key` text NOT NULL,
	`generation` integer NOT NULL,
	`loop` text NOT NULL,
	CONSTRAINT `fk_usine_cycle_reservations_run_id_usine_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `usine_runs`(`run_id`),
	CONSTRAINT `fk_usine_cycle_reservations_item_key_usine_item_cycle_budgets_item_key_fk` FOREIGN KEY (`item_key`) REFERENCES `usine_item_cycle_budgets`(`item_key`),
	CONSTRAINT "usine_cycle_reservations_generation" CHECK("generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE `usine_cycle_resets` (
	`ask_id` text PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	`item_key` text NOT NULL,
	CONSTRAINT `fk_usine_cycle_resets_event_id_usine_events_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `usine_events`(`event_id`),
	CONSTRAINT `fk_usine_cycle_resets_item_key_usine_item_cycle_budgets_item_key_fk` FOREIGN KEY (`item_key`) REFERENCES `usine_item_cycle_budgets`(`item_key`)
);
--> statement-breakpoint
CREATE TABLE `usine_item_cycle_budgets` (
	`item_key` text PRIMARY KEY,
	`repository` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`ask_json` text,
	`reset_pending` integer DEFAULT false NOT NULL,
	CONSTRAINT "usine_item_cycle_generation" CHECK("generation" >= 0),
	CONSTRAINT "usine_item_cycle_ask_json" CHECK("ask_json" is null or json_valid("ask_json"))
);
--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `cycle_limit` integer CHECK (`cycle_limit` is null or `cycle_limit` >= 1);
--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `cycle_generation` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `usine_trigger_events` SET `cycle_limit` = 3
WHERE CASE WHEN json_valid(`item_key`) THEN NOT (
  json_type(`item_key`) = 'array' AND json_array_length(`item_key`) = 2
  AND json_extract(`item_key`, '$[0]') = 'github'
) ELSE 1 END;
--> statement-breakpoint
CREATE INDEX `usine_cycle_reservations_item` ON `usine_cycle_reservations` (`item_key`,`generation`,`loop`);
--> statement-breakpoint
INSERT INTO `usine_item_cycle_budgets` (`item_key`, `repository`)
SELECT `item_key`, min(`repository`) FROM `usine_trigger_events` GROUP BY `item_key`;
--> statement-breakpoint
INSERT INTO `usine_cycle_reservations` (`run_id`, `item_key`, `generation`, `loop`)
SELECT r.`run_id`, e.`item_key`, 0, r.`loop_name`
FROM `usine_runs` r JOIN `usine_trigger_events` e ON e.`event_id` = r.`event_id`;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_cycle_budgets_insert` AFTER INSERT ON `usine_item_cycle_budgets` BEGIN
 UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_cycle_budgets_update` AFTER UPDATE ON `usine_item_cycle_budgets` BEGIN
 UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_cycle_budgets_delete` AFTER DELETE ON `usine_item_cycle_budgets` BEGIN
 UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
