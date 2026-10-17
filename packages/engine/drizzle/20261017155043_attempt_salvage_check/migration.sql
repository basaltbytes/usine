PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usine_attempts` (
	`attempt_id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`step_name` text NOT NULL,
	`worker_name` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`brain_json` text NOT NULL,
	`task` text NOT NULL,
	`agent` text NOT NULL,
	`operator_intervened` integer DEFAULT false NOT NULL,
	`parent_model` text,
	`started_at` text NOT NULL,
	`outcome_json` text,
	`salvage_json` text,
	CONSTRAINT `fk_usine_attempts_run_id_step_name_usine_steps_run_id_step_name_fk` FOREIGN KEY (`run_id`,`step_name`) REFERENCES `usine_steps`(`run_id`,`step_name`),
	CONSTRAINT "usine_attempts_number" CHECK("attempt_number" >= 1),
	CONSTRAINT "usine_attempts_brain_json_valid" CHECK(json_valid("brain_json")),
	CONSTRAINT "usine_attempts_outcome_json_valid" CHECK("outcome_json" is null or json_valid("outcome_json")),
	CONSTRAINT "usine_attempts_salvage_json_valid" CHECK("salvage_json" is null or json_valid("salvage_json"))
);
--> statement-breakpoint
INSERT INTO `__new_usine_attempts`(`attempt_id`, `run_id`, `step_name`, `worker_name`, `attempt_number`, `brain_json`, `task`, `agent`, `operator_intervened`, `parent_model`, `started_at`, `outcome_json`, `salvage_json`) SELECT `attempt_id`, `run_id`, `step_name`, `worker_name`, `attempt_number`, `brain_json`, `task`, `agent`, `operator_intervened`, `parent_model`, `started_at`, `outcome_json`, `salvage_json` FROM `usine_attempts`;--> statement-breakpoint
DROP TABLE `usine_attempts`;--> statement-breakpoint
ALTER TABLE `__new_usine_attempts` RENAME TO `usine_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `usine_item_projection_repository`;--> statement-breakpoint
CREATE UNIQUE INDEX `usine_attempt_number` ON `usine_attempts` (`run_id`,`step_name`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `usine_one_in_flight_attempt` ON `usine_attempts` (`run_id`) WHERE "usine_attempts"."outcome_json" is null;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_attempts_insert` AFTER INSERT ON `usine_attempts` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_attempts_update` AFTER UPDATE ON `usine_attempts` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;
--> statement-breakpoint
CREATE TRIGGER `usine_projection_attempts_delete` AFTER DELETE ON `usine_attempts` BEGIN
	UPDATE `usine_projection_revision` SET `revision` = `revision` + 1 WHERE `singleton` = 1;
END;