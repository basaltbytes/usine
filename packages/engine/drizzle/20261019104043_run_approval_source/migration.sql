PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usine_approvals` (
	`run_id` text PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	`channel` text,
	`approver` text,
	CONSTRAINT `fk_usine_approvals_run_id_usine_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `usine_runs`(`run_id`),
	CONSTRAINT `fk_usine_approvals_event_id_usine_events_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `usine_events`(`event_id`),
	CONSTRAINT "usine_approvals_source" CHECK(("channel" is null and "approver" is null) or "channel" = 'ui' or ("channel" = 'github-ask' and "approver" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_usine_approvals`(`run_id`, `event_id`) SELECT `run_id`, `event_id` FROM `usine_approvals`;--> statement-breakpoint
DROP TABLE `usine_approvals`;--> statement-breakpoint
ALTER TABLE `__new_usine_approvals` RENAME TO `usine_approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;