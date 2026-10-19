CREATE TABLE `usine_run_again_events` (
	`event_id` text PRIMARY KEY,
	`from_run_id` text NOT NULL,
	`requested_by` text,
	CONSTRAINT `fk_usine_run_again_events_event_id_usine_trigger_events_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `usine_trigger_events`(`event_id`),
	CONSTRAINT `fk_usine_run_again_events_from_run_id_usine_runs_run_id_fk` FOREIGN KEY (`from_run_id`) REFERENCES `usine_runs`(`run_id`)
);
