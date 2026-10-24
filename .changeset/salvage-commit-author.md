---
"@usine/executor": patch
"@usine/orchestrator": patch
---

Salvage commits and salvage rebases are authored and committed by the attempt's `commitAuthor`, the GitHub App's bot account, on every worker kind. Before, they used `usine <usine@basaltbytes.dev>`, which no GitHub account owns. The executor's git commands on a checkout now set the same `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables as the attempt's children.

`Executor.recover` takes a third argument, `commitAuthor`: an effect that returns the salvage commit's author. It runs only before a salvage, so removing the checkout of a succeeded or `read` attempt doesn't read it, and its failure leaves the checkout for a later reconciliation. The orchestrator passes the App's bot account.
