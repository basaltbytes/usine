---
"@usine/durable": minor
---

Run an Attempt's Pi parent in the orchestrator on pi-durable storage. `AttemptRuntime` creates one durable task per Attempt, relays its activity as attempt channel envelopes with sequences that continue across restarts, applies operator input, cancels bottom-up, and reads back the `StoredRequest` an Attempt's task was created with through `request`. `DurableHarness` reopens a Session poisoned by a failed commit. `/live` composes the Node runtime with the Claude, Codex, and Pi child backends; `/testing` drives whole Attempts with a scripted parent model and stub children.
