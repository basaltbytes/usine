---
"@usine/durable": minor
---

Adds `AttemptRuntime`, which runs an attempt's Pi parent in the orchestrator as a durable task on pi-durable storage, relays its activity as attempt channel envelopes, applies operator input, and cancels bottom-up. `/live` provides the Node runtime with Claude, Codex, and Pi child backends, and `/testing` runs whole attempts with a scripted parent model and stub children.
