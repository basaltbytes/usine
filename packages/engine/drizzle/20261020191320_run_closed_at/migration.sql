ALTER TABLE `usine_runs` ADD `closed_at` text;--> statement-breakpoint
UPDATE `usine_runs` SET `closed_at` = coalesce(
  (SELECT max(coalesce(`ended_at`, `started_at`)) FROM `usine_attempts` WHERE `usine_attempts`.`run_id` = `usine_runs`.`run_id`),
  `opened_at`
)
WHERE json_extract(`state_json`, '$._tag') NOT IN ('Pending', 'Waiting', 'Queued', 'Running');
