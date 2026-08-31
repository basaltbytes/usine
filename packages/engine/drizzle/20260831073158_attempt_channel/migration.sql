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
);
--> statement-breakpoint
ALTER TABLE `usine_attempts` ADD `worker_name` text NOT NULL;--> statement-breakpoint
ALTER TABLE `usine_runs` ADD `repository` text NOT NULL;--> statement-breakpoint
ALTER TABLE `usine_runs` ADD `revision` text NOT NULL;--> statement-breakpoint
ALTER TABLE `usine_runs` ADD `task` text NOT NULL;--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `repository` text NOT NULL;--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `revision` text NOT NULL;--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `task` text NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usine_steps` (
	`run_id` text NOT NULL,
	`step_name` text NOT NULL,
	`result` text,
	CONSTRAINT `usine_steps_pk` PRIMARY KEY(`run_id`, `step_name`),
	CONSTRAINT `fk_usine_steps_run_id_usine_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `usine_runs`(`run_id`),
	CONSTRAINT "usine_steps_result_json_valid" CHECK("result" is null or json_valid("result"))
);
--> statement-breakpoint
INSERT INTO `__new_usine_steps`(`run_id`, `step_name`, `result`) SELECT `run_id`, `step_name`, `result` FROM `usine_steps`;--> statement-breakpoint
DROP TABLE `usine_steps`;--> statement-breakpoint
ALTER TABLE `__new_usine_steps` RENAME TO `usine_steps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `usine_attempt_transcript_envelope` ON `usine_attempt_transcripts` (`attempt_id`,`direction`,`channel_sequence`);--> statement-breakpoint
CREATE INDEX `usine_attempt_transcript_tail` ON `usine_attempt_transcripts` (`attempt_id`,`sequence`);