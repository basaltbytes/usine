---
"@usine/agents": minor
"@usine/durable": minor
"@usine/server": patch
---

A message to a working child is reported queued until the child reads it, as one to a delegating parent is. `RunningSession.intervene` in `@usine/agents/runtime` takes an `OnDelivery` callback: a message the harness reads only at its next boundary comes back with `InterventionState.queued`, and the callback is called once with the child's state when the harness reads it, or with none when the child stops first. Pi children report the read as the steering message starts in the conversation, Codex children as the steered input is recorded as a user message, and Claude Code children with a result whose `queued_turn_count` no longer counts it; a turn that ends has read every message queued into it. A child emits `SessionResumed` only when it was idle or paused.

The durable Attempt runtime records a child's queued input in `AttemptRecordDoc.queuedInputs` and sends a second receipt for the same input sequence: `InterventionApplied` with the child's state once it read the input, or `InterventionRejected` when the child stopped first or was lost to a restart. A stub child from `@usine/durable/testing` queues a message while it works, and `readQueued` reads it.

The Run page and the Run drawer show a message a working child has not read yet as "Queued until the child finishes its current step".
