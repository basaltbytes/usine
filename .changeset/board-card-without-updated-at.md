---
"@usine/orchestrator": minor
---

`BoardTaskView` in `@usine/orchestrator/operator` no longer carries `updatedAt`, when GitHub last updated the Task's current Item. Only the web UI's former Tasks list order read it. Code that constructs `BoardTaskView` drops the field.
