---
"@usine/engine": patch
---

A runtime store migration drops the index `usine_item_projection_repository`, which covered the same columns as the unique index `usine_item_projection_number`, and adds a `json_valid` check on `usine_attempts.salvage_json`, like the other JSON columns.
