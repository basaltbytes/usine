---
"@usine/core": minor
"@usine/durable": minor
"@usine/orchestrator": minor
---

Attempts can run without a Pi parent session. `RunSpec.parent` selects the coordinator: `pi`, the default and the value that stored attempts decode as, or `none`, which runs the attempt on the event-driven coordinator. `RunSpec.outcomeLabels` gives that coordinator the labels the engine verifies after a success. Configuration doesn't set `parent: none` yet, so every configured attempt still runs its Pi parent.

The event-driven coordinator starts one child with the rendered task and turns the child's end into the attempt's outcome: a report completes it, a reserved marker fails it with its typed failure, a provider capacity refusal fails it with `ProviderCapacityFailure` and the time the usage limit resets, and a launch or transport failure fails it with `InfraFailure`. Each lifecycle event goes through the `WakeUp` seam, and `WakeUp.rules` applies the event's rule, so the coordinator needs no model credential. Its state lives in the attempt journal in the runtime database: an orchestrator restart resumes the open child, applies a decision recorded before its transition, reads a child's recorded outcome instead of starting another child, and replaces a child that couldn't resume once within the child-session budget. Its outbox sends envelopes that the transcript didn't acknowledge again. It refuses operator input for now.

`@usine/durable/live` routes each attempt to the runtime that started it and requires the runtime database's `SqlClient` for the attempt journal; the orchestrator's `runtimeLayer` and the exe.dev engine layer take the shared database layer. `AttemptJournal` adds `startDelegation`, `saveProgress`, `settleDelegation`, `recordResult`, and `recordUnsupervised`, and a second migration adds their columns. `@usine/durable/testing` exports `routedRuntimeLayer`, and its `layer` runs attempts through the router.
