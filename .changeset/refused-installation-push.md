---
"@usine/core": minor
"@usine/engine": patch
"@usine/executor": patch
"@usine/durable": patch
"@usine/orchestrator": minor
"@usine/server": patch
---

Report an HTTP 403 on a salvage push as a `GitHubPushFailure` with the repository, refused ref, GitHub's diagnostic, and the single-repository installation token scope. The run page and Needs attention show the failure while the checkout remains available for salvage recovery. The failure does not retry the attempt automatically, and a later successful salvage preserves its failure history.

`SalvageRetained.pushFailure` records the typed failure. Older salvage records decode this field as `None`. Canceled attempts remain canceled.
