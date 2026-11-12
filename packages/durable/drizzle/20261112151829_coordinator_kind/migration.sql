-- RunSpec.parent (`pi` or `none`) became RunSpec.coordinator (`session` or `events`).
UPDATE `usine_attempt_coordination` SET `request` = json_set(json_remove(`request`, '$.spec.parent'), '$.spec.coordinator', CASE json_extract(`request`, '$.spec.parent') WHEN 'none' THEN 'events' ELSE 'session' END) WHERE json_type(`request`, '$.spec.parent') IS NOT NULL;
