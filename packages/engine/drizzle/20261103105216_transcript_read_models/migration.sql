CREATE TABLE `usine_pool_rate_limits` (
	`pool` text PRIMARY KEY,
	`sequence` integer NOT NULL,
	`attempt_id` text NOT NULL,
	`received_at` text NOT NULL,
	`envelope` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usine_session_usage` (
	`attempt_id` text NOT NULL,
	`session_id` text NOT NULL,
	`total_tokens` integer NOT NULL,
	`sequence` integer NOT NULL,
	`received_at` text NOT NULL,
	`envelope` text NOT NULL,
	CONSTRAINT `usine_session_usage_pk` PRIMARY KEY(`attempt_id`, `session_id`),
	CONSTRAINT `fk_usine_session_usage_attempt_id_usine_attempts_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `usine_attempts`(`attempt_id`)
);
--> statement-breakpoint
ALTER TABLE `usine_attempt_transcripts` ADD `payload_tag` text GENERATED ALWAYS AS (json_extract(envelope, '$.payload._tag')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `usine_attempt_transcripts` ADD `event_tag` text GENERATED ALWAYS AS (json_extract(envelope, '$.payload.event._tag')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `usine_attempt_transcripts` ADD `session_id` text GENERATED ALWAYS AS (coalesce(json_extract(envelope, '$.payload.event.session.id'), json_extract(envelope, '$.payload.intervention.target.sessionId'))) VIRTUAL;--> statement-breakpoint
CREATE INDEX `usine_attempt_transcript_kind` ON `usine_attempt_transcripts` (`attempt_id`,`payload_tag`,`event_tag`,`sequence`);
--> statement-breakpoint
INSERT INTO usine_session_usage (attempt_id, session_id, total_tokens, sequence, received_at, envelope)
SELECT attempt_id, session_id, max(json_extract(envelope, '$.payload.event.totalTokens')),
  sequence, received_at, envelope
FROM usine_attempt_transcripts
WHERE direction = 'outbound' AND payload_tag = 'SessionEvent' AND event_tag = 'SessionTokensUpdated'
GROUP BY attempt_id, session_id;
--> statement-breakpoint
INSERT INTO usine_pool_rate_limits (pool, sequence, attempt_id, received_at, envelope)
SELECT json_extract(envelope, '$.payload.event.pool'), max(sequence), attempt_id, received_at, envelope
FROM usine_attempt_transcripts
WHERE direction = 'outbound'
  AND json_extract(envelope, '$.payload._tag') = 'SessionEvent'
  AND json_extract(envelope, '$.payload.event._tag') = 'PoolRateLimitsUpdated'
GROUP BY json_extract(envelope, '$.payload.event.pool');
--> statement-breakpoint
DROP INDEX IF EXISTS usine_attempt_transcript_pool_limits;
