---
"@usine/orchestrator": patch
---

A failed run on an issue that is closed or a pull request that is closed or merged no longer sets the project's status to `needs-you` or marks its board card and task as needing attention. The project status, the card, the task, and Needs attention now use the same check, so a project no longer shows `needs-you` with an empty Needs attention list.
