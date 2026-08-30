ALTER TABLE `usine_trigger_events` ADD `repository` text DEFAULT 'unknown/unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `revision` text DEFAULT 'HEAD' NOT NULL;--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `task` text DEFAULT 'Migrated run context unavailable' NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_usine_steps` (
	`run_id` text NOT NULL,
	`step_name` text NOT NULL,
	`result` text,
	CONSTRAINT `usine_steps_pk` PRIMARY KEY(`run_id`, `step_name`),
	CONSTRAINT `fk_usine_steps_run_id_usine_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `usine_runs`(`run_id`),
	CONSTRAINT "usine_steps_result_json_valid" CHECK("result" is null or json_valid("result"))
);--> statement-breakpoint
INSERT INTO `__new_usine_steps`(`run_id`, `step_name`, `result`)
SELECT `run_id`, `step_name`, CASE
	WHEN `result` IS NULL THEN NULL
	ELSE json_object('message', `result`, 'facts', json('[]'))
END
FROM `usine_steps`;--> statement-breakpoint
CREATE TABLE `__new_usine_attempts` (
	`attempt_id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`step_name` text NOT NULL,
	`worker_name` text DEFAULT 'local' NOT NULL,
	`attempt_number` integer NOT NULL,
	`started_at` text NOT NULL,
	`outcome_json` text,
	CONSTRAINT `fk_usine_attempts_run_id_step_name_usine_steps_run_id_step_name_fk` FOREIGN KEY (`run_id`,`step_name`) REFERENCES `__new_usine_steps`(`run_id`,`step_name`),
	CONSTRAINT "usine_attempts_number" CHECK("attempt_number" >= 1),
	CONSTRAINT "usine_attempts_outcome_json_valid" CHECK("outcome_json" is null or json_valid("outcome_json"))
);--> statement-breakpoint
INSERT INTO `__new_usine_attempts`(
	`attempt_id`, `run_id`, `step_name`, `worker_name`, `attempt_number`, `started_at`, `outcome_json`
)
SELECT `attempt_id`, `run_id`, `step_name`, 'local', `attempt_number`, `started_at`, `outcome_json`
FROM `usine_attempts`;--> statement-breakpoint
DROP TABLE `usine_attempts`;--> statement-breakpoint
DROP TABLE `usine_steps`;--> statement-breakpoint
ALTER TABLE `__new_usine_steps` RENAME TO `usine_steps`;--> statement-breakpoint
ALTER TABLE `__new_usine_attempts` RENAME TO `usine_attempts`;--> statement-breakpoint
CREATE UNIQUE INDEX `usine_attempt_number` ON `usine_attempts` (`run_id`,`step_name`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `usine_one_in_flight_attempt` ON `usine_attempts` (`run_id`) WHERE "usine_attempts"."outcome_json" is null;--> statement-breakpoint
CREATE TABLE `usine_attempt_transcripts` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`attempt_id` text NOT NULL,
	`direction` text NOT NULL,
	`channel_sequence` integer NOT NULL,
	`envelope` text NOT NULL,
	`received_at` text NOT NULL,
	CONSTRAINT `fk_usine_attempt_transcripts_attempt_id_usine_attempts_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `usine_attempts`(`attempt_id`),
	CONSTRAINT "usine_attempt_transcripts_direction" CHECK("direction" in ('inbound', 'outbound')),
	CONSTRAINT "usine_attempt_transcripts_sequence" CHECK("channel_sequence" >= 1),
	CONSTRAINT "usine_attempt_transcripts_envelope_json_valid" CHECK(json_valid("envelope"))
);--> statement-breakpoint
CREATE UNIQUE INDEX `usine_attempt_transcript_envelope` ON `usine_attempt_transcripts` (`attempt_id`,`direction`,`channel_sequence`);--> statement-breakpoint
CREATE INDEX `usine_attempt_transcript_tail` ON `usine_attempt_transcripts` (`attempt_id`,`sequence`);
