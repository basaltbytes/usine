CREATE TABLE `usine_attempt_inputs` (
	`attempt_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`session_id` text NOT NULL,
	`intervention` text NOT NULL,
	CONSTRAINT `usine_attempt_inputs_pk` PRIMARY KEY(`attempt_id`, `sequence`),
	CONSTRAINT `fk_usine_attempt_inputs_attempt_id_usine_attempt_coordination_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `usine_attempt_coordination`(`attempt_id`)
);
--> statement-breakpoint
CREATE TABLE `usine_attempt_supervision` (
	`attempt_id` text NOT NULL,
	`session_id` text NOT NULL,
	`held` integer NOT NULL,
	`paused` integer NOT NULL,
	CONSTRAINT `usine_attempt_supervision_pk` PRIMARY KEY(`attempt_id`, `session_id`),
	CONSTRAINT `fk_usine_attempt_supervision_attempt_id_usine_attempt_coordination_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `usine_attempt_coordination`(`attempt_id`)
);
--> statement-breakpoint
ALTER TABLE `usine_attempt_coordination` ADD `next_inbound` integer DEFAULT 1 NOT NULL;