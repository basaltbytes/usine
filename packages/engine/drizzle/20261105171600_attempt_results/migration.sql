ALTER TABLE `usine_attempts` ADD `result_json` text;
--> statement-breakpoint
UPDATE `usine_attempts`
SET `result_json` = (
  SELECT json_set(`step`.`result`, '$.attemptId', `usine_attempts`.`attempt_id`)
  FROM `usine_steps` AS `step`
  WHERE `step`.`run_id` = `usine_attempts`.`run_id`
    AND `step`.`step_name` = `usine_attempts`.`step_name`
    AND `step`.`result` IS NOT NULL
    AND `usine_attempts`.`attempt_id` = coalesce(
      json_extract(`step`.`result`, '$.attemptId'),
      (SELECT `producer`.`attempt_id` FROM `usine_attempts` AS `producer`
       WHERE `producer`.`run_id` = `step`.`run_id`
         AND `producer`.`step_name` = `step`.`step_name`
       ORDER BY `producer`.`attempt_number` DESC LIMIT 1)
    )
);
