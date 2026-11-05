CREATE TABLE `usine_attempt_transcript_seals` (
	`attempt_id` text PRIMARY KEY,
	`sealed_at` text NOT NULL,
	`last_inbound_sequence` integer,
	`last_outbound_sequence` integer,
	`last_received_at` text NOT NULL,
	CONSTRAINT `fk_usine_attempt_transcript_seals_attempt_id_usine_attempts_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `usine_attempts`(`attempt_id`)
);
--> statement-breakpoint
CREATE TABLE `usine_attempt_transcript_segments` (
	`attempt_id` text NOT NULL,
	`first_sequence` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	`rows` integer NOT NULL,
	`raw_bytes` integer NOT NULL,
	`codec` text NOT NULL,
	`body` blob NOT NULL,
	CONSTRAINT `usine_attempt_transcript_segments_pk` PRIMARY KEY(`attempt_id`, `first_sequence`),
	CONSTRAINT `fk_usine_attempt_transcript_segments_attempt_id_usine_attempts_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `usine_attempts`(`attempt_id`)
);
