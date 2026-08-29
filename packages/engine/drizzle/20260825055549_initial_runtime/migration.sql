CREATE TABLE `usine_approvals` (
	`run_id` text PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	CONSTRAINT `fk_usine_approvals_run_id_usine_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `usine_runs`(`run_id`),
	CONSTRAINT `fk_usine_approvals_event_id_usine_events_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `usine_events`(`event_id`)
);
--> statement-breakpoint
CREATE TABLE `usine_attempts` (
	`attempt_id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`step_name` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`started_at` text NOT NULL,
	`outcome_json` text,
	CONSTRAINT `fk_usine_attempts_run_id_step_name_usine_steps_run_id_step_name_fk` FOREIGN KEY (`run_id`,`step_name`) REFERENCES `usine_steps`(`run_id`,`step_name`),
	CONSTRAINT "usine_attempts_number" CHECK("attempt_number" >= 1),
	CONSTRAINT "usine_attempts_outcome_json_valid" CHECK("outcome_json" is null or json_valid("outcome_json"))
);
--> statement-breakpoint
CREATE TABLE `usine_events` (
	`event_id` text PRIMARY KEY,
	`dedup_key` text NOT NULL UNIQUE,
	`payload_json` text NOT NULL,
	`received_at` text NOT NULL,
	CONSTRAINT "usine_events_payload_json_valid" CHECK(json_valid("payload_json"))
);
--> statement-breakpoint
CREATE TABLE `usine_ignored_events` (
	`event_id` text PRIMARY KEY,
	`reason` text NOT NULL,
	CONSTRAINT `fk_usine_ignored_events_event_id_usine_trigger_events_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `usine_trigger_events`(`event_id`),
	CONSTRAINT "usine_ignored_events_reason" CHECK("reason" in ('superseded', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE `usine_runs` (
	`run_id` text PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	`loop_name` text NOT NULL,
	`state_json` text NOT NULL,
	`opened_at` text NOT NULL,
	CONSTRAINT `fk_usine_runs_event_id_usine_trigger_events_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `usine_trigger_events`(`event_id`),
	CONSTRAINT "usine_runs_state_json_valid" CHECK(json_valid("state_json"))
);
--> statement-breakpoint
CREATE TABLE `usine_steps` (
	`run_id` text NOT NULL,
	`step_name` text NOT NULL,
	`result` text,
	CONSTRAINT `usine_steps_pk` PRIMARY KEY(`run_id`, `step_name`),
	CONSTRAINT `fk_usine_steps_run_id_usine_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `usine_runs`(`run_id`)
);
--> statement-breakpoint
CREATE TABLE `usine_trigger_events` (
	`event_id` text PRIMARY KEY,
	`item_key` text NOT NULL,
	`loop_name` text NOT NULL,
	`step_name` text NOT NULL,
	`approval` text NOT NULL,
	CONSTRAINT `fk_usine_trigger_events_event_id_usine_events_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `usine_events`(`event_id`),
	CONSTRAINT "usine_trigger_events_approval" CHECK("approval" in ('none', 'required'))
);
--> statement-breakpoint
CREATE TABLE `usine_workflow_commands` (
	`run_id` text NOT NULL,
	`command` text NOT NULL,
	CONSTRAINT `usine_workflow_commands_pk` PRIMARY KEY(`run_id`, `command`),
	CONSTRAINT `fk_usine_workflow_commands_run_id_usine_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `usine_runs`(`run_id`),
	CONSTRAINT "usine_workflow_commands_command" CHECK("command" in ('Approve', 'Continue', 'Interrupt', 'Resume'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usine_attempt_number` ON `usine_attempts` (`run_id`,`step_name`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `usine_one_in_flight_attempt` ON `usine_attempts` (`run_id`) WHERE "usine_attempts"."outcome_json" is null;--> statement-breakpoint
CREATE INDEX `usine_trigger_events_item` ON `usine_trigger_events` (`loop_name`,`item_key`);