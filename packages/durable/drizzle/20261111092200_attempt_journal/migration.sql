CREATE TABLE `usine_attempt_coordination` (
	`attempt_id` text PRIMARY KEY,
	`request` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text,
	`status` text NOT NULL,
	`next_outbound` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usine_attempt_delegations` (
	`attempt_id` text NOT NULL,
	`number` integer NOT NULL,
	`delegation` text NOT NULL,
	CONSTRAINT `usine_attempt_delegations_pk` PRIMARY KEY(`attempt_id`, `number`),
	CONSTRAINT `fk_usine_attempt_delegations_attempt_id_usine_attempt_coordination_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `usine_attempt_coordination`(`attempt_id`)
);
--> statement-breakpoint
CREATE TABLE `usine_attempt_events` (
	`attempt_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event` text,
	`decision` text NOT NULL,
	CONSTRAINT `usine_attempt_events_pk` PRIMARY KEY(`attempt_id`, `sequence`),
	CONSTRAINT `fk_usine_attempt_events_attempt_id_usine_attempt_coordination_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `usine_attempt_coordination`(`attempt_id`)
);
--> statement-breakpoint
CREATE TABLE `usine_attempt_outbox` (
	`attempt_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`envelope` text NOT NULL,
	CONSTRAINT `usine_attempt_outbox_pk` PRIMARY KEY(`attempt_id`, `sequence`),
	CONSTRAINT `fk_usine_attempt_outbox_attempt_id_usine_attempt_coordination_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `usine_attempt_coordination`(`attempt_id`)
);
