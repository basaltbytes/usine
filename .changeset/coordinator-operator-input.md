---
"@usine/agents": minor
"@usine/durable": minor
---

The event-driven coordinator applies operator input instead of refusing it. Input for a child goes to that child. Input addressed to the parent, including the runaway guard's warning steer, goes to the attempt's live child, and its receipts name the child in `forwardedTo`. With no live child, the input is rejected with `InterventionRejected`. An operator message holds the child's report until a release, an interrupt pauses the child, and a working child's queued message gets a second receipt when the child reads it, or a rejection once the child ends without reading it. The attempt journal keeps each child's Hold, pause, and queued input, so a child resumed after an orchestrator restart restores them. `AttemptJournal` adds `supervise`, `queueInput`, `forgetInput`, and `recordInbound`, and `CoordinatorSnapshot` adds `supervision`, `inputs`, and `nextInbound`; a third migration adds their tables and column.

`SessionResult.answeredOperator` is true when a session read an operator message or steer after its last tool call. The shared conversation sets it for Claude Code, Codex, and Pi, and the coordinator passes it to `AttemptReport.answeredOperator`, so an attempt whose child answered the operator and produced no commit, pull request, comment, or step output fails with `AgentFailure`, as it does for a Pi parent.
