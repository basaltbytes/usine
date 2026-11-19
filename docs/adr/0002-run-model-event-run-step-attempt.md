# Run model: Event → Run → Step → Attempt

usine adapts Inngest's run model. An event's dedup key comes from the watched state, never a timestamp, and the ledger keeps every key, so usine never acts twice on one state. An event opens at most one run, whose ID hashes the dedup key. A run does named steps with stored results, one per run today, and each try of a step is an attempt.

A loop has at most one open run per item. A newer event supersedes it only before an attempt starts; otherwise the event waits until the run ends. An approval is an event. The operator can retry a failed run, and run a succeeded or canceled run again, since a run can succeed with its item unresolved and a quick label round trip looks unchanged to polling. Run again records a new event for the same state, so polling still acts once.

Automatic retry resumes salvaged work and covers only failures outside the agent. Infrastructure failures get three attempts. A capacity refusal never fails the run, as usage limits last hours: it waits for the reset or a growing backoff while one attempt at a time tests the refused pool. Every other failure waits for the operator, including an escaped executor defect, so a bug doesn't repeat agent work.

Each open run is one engine fiber over usine's own run tables. It reserves a worker, opens or reattaches an attempt, and records its outcome until the run closes. A run waiting for approval or for CI ([ADR 0033](./0033-durable-ci-waits.md)) has no fiber.

Built: two coordinators, selected by `coordinator: session | events` (#1157, #1158): the Pi parent, a pi-durable task, and the event-driven coordinator. Decided, not built: the second replaces the first (#1166).

## Considered options

- **n8n's shape**, a run per trigger firing and a linked run per retry: splits one piece of work's history.
- **Temporal's shape**: replay determinism and a server cluster; usine takes only its business-key uniqueness.
- **Inngest, as-is or self-hosted**: its 24-hour idempotency window breaks permanent dedup, and its server needs Redis beside SQL.
- **Effect workflow and cluster as the durable store** (removed in #176): a second store over state that usine's tables already hold, with drift to repair.
- **A timestamp in event identity**, to see a quick label round trip: polling could act twice on unchanged content.
