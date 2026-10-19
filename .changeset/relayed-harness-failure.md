---
"@usine/agents": minor
"@usine/durable": minor
"@usine/server": patch
---

A child's harness failure, such as a failed Codex turn, no longer holds the Item. It reached the parent as a `[usine:blocked]` report and ended the Attempt with `BlockedFailure`, so the Loop held the Item although nothing was posted on it, and the operator's next push or reply opened no Run.

`@usine/agents/runtime` adds `FAILED_MARKER`, `[usine:failed]`. `reportText` writes it for an `AgentResultError`, and `reportedOutcome` reads it back as `AgentResultError`, which `toAttemptFailure` maps to `AgentFailure`. The `subagent` tool relays a child's harness failure with it, the parent's guidance lists it with the other markers to return verbatim, and the Attempt record keeps it with the kind `failed`, so a parent that does not relay it also ends the Attempt with `AgentFailure`. Only `[usine:blocked]` ends an Attempt with `BlockedFailure`. The stub child in `@usine/durable/testing` adds `fail`, which finishes it with a harness failure.

The Run page's reader leaves the `[usine:failed]` marker out of the message it shows, as it does for the other markers.
