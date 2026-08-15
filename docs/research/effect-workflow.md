# Effect workflow modules as usine's durable-execution engine

Researched 2026-08-15 for [The run model: entities, states, idempotency](https://github.com/basaltbytes/usine/issues/7) and [Persistence: what's durable and where](https://github.com/basaltbytes/usine/issues/13). All claims verified against live sources on that date. This research fed [ADR 0003](https://github.com/basaltbytes/usine/blob/main/docs/adr/0003-durable-execution-on-effect-workflow.md).

## What exists

- Two layers, one system: `@effect/workflow` (durable workflow definitions) and `@effect/cluster` (the runtime, via `ClusterWorkflowEngine`). Versions on npm as of 2026-08-15: `@effect/workflow` 0.19.1, `@effect/cluster` 0.60.2, both peering on `effect ^3.22.1` — the v3 line. In **Effect v4** (rc 4.0.0-rc.109, published 2026-08-14) both are folded into core as unstable modules: `effect/unstable/workflow` (Activity, DurableClock, DurableDeferred, DurableQueue, Workflow, WorkflowEngine, WorkflowProxy) and `effect/unstable/cluster` (ClusterWorkflowEngine, SingleRunner, SqlMessageStorage, Entity, Sharding). https://github.com/Effect-TS/effect/tree/main/packages/effect/src/unstable/workflow
- API surface: `Workflow.make({ name, success, error, payload, idempotencyKey })`; `Activity.make` ("only ever executed once, unless you use Activity.retry"); `DurableClock.sleep` (suspension consumes no resources); `DurableDeferred` (token-based signal — `succeed`/`fail` from any code with `WorkflowEngine` access, `await` suspends); compensation via `withCompensation`. https://github.com/Effect-TS/effect/blob/v3/packages/workflow/README.md
- **Status: officially alpha.** Effect's posts as of July 2026 still say "currently in alpha"; v4 `unstable/*` modules "may receive breaking changes in minor releases". https://www.effect.website/blog/releases/effect/40-beta

## Persistence and single-process

- `SqlMessageStorage` supports mssql, mysql, pg, and sqlite. Tables `${prefix}_messages`, `${prefix}_replies`, `${prefix}_migrations` (prefix `"cluster"`). v4 ships first-party sql drivers (pg, sqlite-node, libsql, pglite). https://github.com/Effect-TS/effect/blob/v3/packages/cluster/src/SqlMessageStorage.ts
- **Single process: yes, explicitly, in v4** — `SingleRunner.layer`: "meant for local, embedded, or small single-node setups where the process handles all cluster work itself"; needs only `SqlClient` + `Crypto`. https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/cluster/SingleRunner.ts

## Coverage of usine's needs

- **Named memoized steps:** Activities store results by name and replay them on re-run.
- **Approval waits:** `DurableDeferred.await` suspends; completion can come from any process code — maps directly to "approval Event consumed by a waiting run".
- **Typed capped retries:** `Activity.retry` takes retry options with `times` + `while`/`until` predicates over the typed error — "retry infra errors only, capped" is directly expressible; `Activity.CurrentAttempt` exposes the attempt number.
- **Operator retry:** `Workflow.SuspendOnFailure` suspends on any error; `Workflow.resume(executionId)` resumes manually.
- **Cancellation:** `Workflow.interrupt(executionId)` and `poll(executionId)` in-process. The generated `WorkflowProxy` HTTP/RPC surface exposes only execute/discard/resume — fine for a single process.
- **Hours-long steps:** no activity-level timeout exists. Suspension costs nothing; a running step is a live fiber. Caveat: activities are memoized-on-success, at-least-once on crash — a process restart mid-step re-runs the whole step.
- **Introspection: semi-opaque.** `executionId` is deterministic — `hash(workflowName + "-" + idempotencyKey(payload))` — so any process can compute it and poll. But there is **no list-runs API**; durable state lives in `cluster_messages`/`cluster_replies` as serialized RPC envelopes. A UI listing runs must maintain its own index.

## What usine still hand-rolls

- The Event table and dedup ledger; "one open run per key"; supersede (interrupt the stale run, execute the new Event).
- The operator surface: approve = complete a `DurableDeferred` from the event ingester; retry-with-steer = `Workflow.resume` plus usine's own channel for the steering text.
- Run/attempt listing for the UI: an index (the Run/Step/Attempt tables) mapping dedup key → executionId → status; attempt history (`CurrentAttempt` is only visible in-flight).
- Result retention/pruning and human-readable run metadata.

## Maturity signals

- High cadence: ~40 workflow releases Jun 2025→Jul 2026; weekly durable-execution fixes still landing.
- On-point open issues: [#6176](https://github.com/Effect-TS/effect/issues/6176) SQLite "database is locked" under concurrent runner + client access (multi-process); [#6294](https://github.com/Effect-TS/effect/issues/6294) resume latency gated on the 10 s `entityMessagePollInterval`; [#6248](https://github.com/Effect-TS/effect/issues/6248), [#6180](https://github.com/Effect-TS/effect/issues/6180).
- Real-world use exists (e.g. CapSoftware/Cap uses `@effect/workflow` Activities in production code).

## Assessment

Feature-wise a remarkably exact match for the decided run model: activities = steps, DurableDeferred = approval Events, SuspendOnFailure + resume = operator retry, interrupt = supersede/cancel, typed capped retries, no step timeout, and `SingleRunner` is purpose-built for the one-process-one-DB shape. Costs: alpha churn (absorb via exact pin behind a usine-owned seam), an envelope store with no list-runs API (usine's four tables are the index and operator surface regardless), 10 s resume latency, and the SQLite lock issue — which concerns multi-process access and is sidestepped by the single orchestrator process or Postgres. Chosen as the substrate in ADR 0003; the research's hand-roll recommendation was overridden by the operator on the grounds that crash-safe resume plus deferred signals is the genuinely hard part and Effect provides it.
