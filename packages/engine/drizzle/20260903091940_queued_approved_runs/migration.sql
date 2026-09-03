UPDATE `usine_runs` SET `state_json` = '{"_tag":"Queued"}'
WHERE json_extract(`state_json`, '$._tag') = 'Waiting'
  AND `run_id` IN (SELECT `run_id` FROM `usine_approvals`);
