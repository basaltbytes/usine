# Run model: Event → Run → Step → Attempt

usine adapts Inngest's run model rather than n8n's or Temporal's (see [run-model research](https://github.com/basaltbytes/usine/blob/research/run-models/docs/research/run-models.md)): a deduplicated Event owns at most one open Run, the Run's work lives in named Steps with stored results (exactly one in v1), and every execution try is an Attempt under its Step. Dedup keys are derived by the engine per trigger type and never expire — "never act twice on the same state" is a permanent ledger, not Inngest's 24-hour window — and a coarser item key lets a newer Event supersede a stale open run.

## Considered Options

- **n8n's shape** (trigger firing = run, retry = a new linked run) — conflates identity and splinters the history of one piece of work.
- **Temporal's shape** — the business-key uniqueness invariant is borrowed; the replay-determinism regime and server cluster are not, since memoized step results give resumability without them.
- **Inngest's shape as-is** — the closest fit, but its 24 h idempotency window contradicts the permanent guarantee, and its trigger→run coupling hides the Event as a first-class row.

## Consequences

- Run state machine: pending → waiting (per-loop approval gate) → running → succeeded / failed / canceled; failed → running on operator retry (attempt N+1, with optional steering text on the attempt); canceled is reachable from any open state (operator cancel, or supersede).
- An approval is an Event the waiting run consumes — deduplicated and auditable like every other fact, and v1's only waiting reason.
- Loop-authored step names are step identity (mirroring filename = loop identity, [ADR 0001](./0001-loops-live-in-the-instance-repo.md)): renaming a step retires it; prior results stay under the old name.
- Auto-retry applies only to typed infra errors, capped at 2–3 attempts; agent-level failures always wait for the operator.
- Polling cursors are an efficiency detail only — the dedup key is the guarantee.
