# Durable execution on Effect workflow, projected into usine's own tables

usine delegates durable execution (memoized step results, suspend until a signal, resume after failure, capped typed retries, interruption) to Effect's `effect/unstable/workflow` and `effect/unstable/cluster` modules, with `SingleRunner` on one SQL database. Like Pi, they're exact-pinned behind a usine engine seam. The UI reads usine's own event, run, step, and attempt tables, since Effect has no list-runs API; Effect's state store is an implementation detail.

## Considered options

- **Hand-rolled durable execution on the four tables**: fully inspectable and recommended by the [substrate research](https://github.com/basaltbytes/usine/blob/research/engine-substrate/docs/research/effect-workflow.md). Rejected by the operator: Effect already provides the hard part, crash-safe resume with deferred signals (`DurableDeferred` for approval events, `SuspendOnFailure` and resume for operator retry, interrupt for cancel and supersede).
- **Self-hosted Inngest server**: needs Redis next to SQL, hard-codes a 24-hour idempotency TTL against the permanent dedup guarantee, and caps HTTP-driven steps at 2 hours (persistent workers are beta). Its open SDK spec and Apache-licensed workflow-kit stay design references ([research](https://github.com/basaltbytes/usine/blob/research/engine-substrate/docs/research/inngest-oss.md)).

## Consequences

- Alpha modules, exempt from semver in minors: pinned exactly, upgraded as deliberate migrations at the seam.
- Execution ids hash the workflow name and idempotency key (usine's dedup key), so the same event joins the same run for free.
- A mid-step crash reruns the agent session as a new attempt.
- The SQLite lock issue ([Effect-TS/effect#6176](https://github.com/Effect-TS/effect/issues/6176)) affects multi-process access. One orchestrator process, or Postgres, avoids it.

A defect escaping the `StepExecutor` port becomes `DefectFailure` at the durable boundary: the cause is kept, the attempt fails terminally, and it's never retried automatically. This avoids a run suspended forever with an open attempt, and repeated agent work after a bug. Other engine defects keep defect semantics.

## Amendment (2026-10-11, #176): each open run is an engine fiber over the run tables

The Effect workflow and cluster modules are gone. An attempt is the pi-durable task running its Pi parent (ADR 0006 amendment of 2026-10-08), so pi-durable now does the hard part: resuming an agent session that a crash cut off. The run level is a small state machine already stored in usine's tables, and a second durable store only added commands to replay and drift to repair.

Each open run is one engine fiber that waits for approval if gated, reserves a worker, opens or reattaches the attempt, records the outcome, and repeats until the run closes. Approval, retry, cancel, supersede, and revoke commit through the store, then start or stop the fiber. At startup, the engine starts a fiber per open run (gated runs keep waiting) and opens the queued events of items whose run closed before its continuation ran. Run ids still hash the dedup key with Effect's input, so they don't change. Escaping defects still become `DefectFailure` at the attempt boundary.
