---
"@usine/core": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Outcome label verification counts only the labels that an attempt's GitHub account added during that attempt, or that an earlier attempt of the same run added during that earlier attempt. Local, SSH, and Cloudflare workers write as the GitHub App's bot, which usine also uses for `on_green` labels, so a label added between two attempts no longer counts for the retry. A read that GitHub answers with a response usine can't use, such as a timeline of more than ten pages, falls back to the current labels without a retry.

`Attempt.workerKind` records the kind of the attempt's worker when it starts, and the check reads each attempt's GitHub account from it, so a later change to the worker's kind doesn't change the account. Older attempts have none and use their worker's configured kind. The SQLite store adds a nullable `worker_kind` column to `usine_attempts`. A `StepExecutor` lease (`WorkerLease`) has a required `kind`: the kind of the leased worker.

`FailedAttemptView.report` is the final report that an attempt kept when the completion check rejected it, set in run detail reads and null in run lists. The run page and run drawer show it under **Final report**, after the failure.
