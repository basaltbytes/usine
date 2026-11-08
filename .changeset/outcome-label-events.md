---
"@usine/engine": patch
"@usine/orchestrator": patch
---

Verify a loop's outcome labels from the attempt's label events on GitHub. An outcome label that the attempt added counts even if another loop removed it before the attempt settled, and a label left from an earlier run doesn't count. usine checks the item's current labels only when it can't read the label events.

Retry outcome label reads only after a timeout or a GitHub server error. Verify each completion once, skip the check when the run doesn't record the success, and keep a rejected report's message and facts on the failed attempt.

`CompletionCheck` moves to `@usine/engine/completion-check` and becomes a required service with a `verify` method. Hosts that don't verify outcome labels provide `CompletionCheck.unverified`.
