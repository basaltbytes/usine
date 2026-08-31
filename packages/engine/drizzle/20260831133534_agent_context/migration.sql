ALTER TABLE `usine_runs` ADD `agent_json` text;--> statement-breakpoint
ALTER TABLE `usine_runs` ADD `parent_model` text;--> statement-breakpoint
UPDATE `usine_runs` SET `agent_json` = '{"name":"legacy-agent","brain":{"harness":"pi","model":"legacy-stub","effort":"off"},"parentModel":null,"persona":"Created before agent context was recorded."}' WHERE `agent_json` IS NULL;--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `agent_json` text;--> statement-breakpoint
ALTER TABLE `usine_trigger_events` ADD `parent_model` text;--> statement-breakpoint
UPDATE `usine_trigger_events` SET `agent_json` = '{"name":"legacy-agent","brain":{"harness":"pi","model":"legacy-stub","effort":"off"},"parentModel":null,"persona":"Created before agent context was recorded."}' WHERE `agent_json` IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usine_runs` (
	`run_id` text PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	`loop_name` text NOT NULL,
	`state_json` text NOT NULL,
	`opened_at` text NOT NULL,
	`repository` text NOT NULL,
	`revision` text NOT NULL,
	`task` text NOT NULL,
	`agent_json` text NOT NULL,
	`parent_model` text,
	CONSTRAINT `fk_usine_runs_event_id_usine_trigger_events_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `usine_trigger_events`(`event_id`),
	CONSTRAINT "usine_runs_state_json_valid" CHECK(json_valid("state_json")),
	CONSTRAINT "usine_runs_agent_json_valid" CHECK(json_valid("agent_json"))
);
--> statement-breakpoint
INSERT INTO `__new_usine_runs`(`run_id`, `event_id`, `loop_name`, `state_json`, `opened_at`, `repository`, `revision`, `task`, `agent_json`, `parent_model`) SELECT `run_id`, `event_id`, `loop_name`, `state_json`, `opened_at`, `repository`, `revision`, `task`, `agent_json`, `parent_model` FROM `usine_runs`;--> statement-breakpoint
DROP TABLE `usine_runs`;--> statement-breakpoint
ALTER TABLE `__new_usine_runs` RENAME TO `usine_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usine_trigger_events` (
	`event_id` text PRIMARY KEY,
	`item_key` text NOT NULL,
	`loop_name` text NOT NULL,
	`step_name` text NOT NULL,
	`approval` text NOT NULL,
	`repository` text NOT NULL,
	`revision` text NOT NULL,
	`task` text NOT NULL,
	`agent_json` text NOT NULL,
	`parent_model` text,
	CONSTRAINT `fk_usine_trigger_events_event_id_usine_events_event_id_fk` FOREIGN KEY (`event_id`) REFERENCES `usine_events`(`event_id`),
	CONSTRAINT "usine_trigger_events_approval" CHECK("approval" in ('none', 'required')),
	CONSTRAINT "usine_trigger_events_agent_json_valid" CHECK(json_valid("agent_json"))
);
--> statement-breakpoint
INSERT INTO `__new_usine_trigger_events`(`event_id`, `item_key`, `loop_name`, `step_name`, `approval`, `repository`, `revision`, `task`, `agent_json`, `parent_model`) SELECT `event_id`, `item_key`, `loop_name`, `step_name`, `approval`, `repository`, `revision`, `task`, `agent_json`, `parent_model` FROM `usine_trigger_events`;--> statement-breakpoint
DROP TABLE `usine_trigger_events`;--> statement-breakpoint
ALTER TABLE `__new_usine_trigger_events` RENAME TO `usine_trigger_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `usine_trigger_events_item` ON `usine_trigger_events` (`loop_name`,`item_key`);
