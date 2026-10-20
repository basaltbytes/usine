---
"@usine/orchestrator": patch
---

At most once every 10 minutes per repository, the poll asks GitHub whether it still has each issue stored as open, and marks each deleted or transferred one gone, so its card leaves the Board's open lanes, and revokes its unstarted Runs.
