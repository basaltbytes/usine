---
"@usine/server": patch
---

The web UI's Tasks list keeps each task title on one line in the width the other columns leave. Status, Runs, and Last run take their own width up to a share of the table that leaves the title 416px, and past it Status and Last run wrap and Runs truncates, so a long status wraps before the title is cut short and a short status such as `Done` takes only its words. At 1440px beside the sidebar, titles such as `Document the public API of @usine/orchestrator in TSDoc` show in full.
