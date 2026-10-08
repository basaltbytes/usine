# @usine/durable

The Pi parent of an Attempt, run inside the orchestrator on `@earendil-works/pi-durable` storage instead of a one-shot run host on the Worker. Each Attempt is one durable task that owns one parent conversation; the orchestrator reopens the storage at startup and resumes every unfinished Attempt where it stopped. The parent's only tool spawns the usine child backends (Claude, Codex, Pi) in the Attempt's checkout.

`@usine/durable/attempt-runtime` is the contract the executor calls. See `docs/research/pi-durable.md` and issue #176 for the decision.
