CREATE INDEX `usine_attempts_run_number` ON `usine_attempts` (`run_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `usine_runs_state_opened` ON `usine_runs` (json_extract("state_json", '$._tag'),`opened_at`,`run_id`);--> statement-breakpoint
CREATE INDEX `usine_runs_closed` ON `usine_runs` (`closed_at`,`run_id`);--> statement-breakpoint
CREATE INDEX `usine_runs_closed_opened` ON `usine_runs` ("closed_at" is not null,`opened_at`,`run_id`);--> statement-breakpoint
CREATE INDEX `usine_runs_fix_run` ON `usine_runs` (cast(json_extract("state_json", '$.fixRunId') as text));