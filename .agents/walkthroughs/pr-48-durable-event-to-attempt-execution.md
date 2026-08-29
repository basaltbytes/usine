---
walkthrough: 1
title: Durable Event-to-Attempt execution
pr: 48
commit: 59b38377838f31cbbf443efc13bdd9d7deee3e25
meta:
  pull-request: "#48"
  scope: engine, persistence, recovery
  balade-authoring: 1.33.0
---

{% group label="Overview" %}
{% section id="overview" title="Durable run engine" icon="git-pull-request" %}
This change turns `@usine/engine` from a reserved package entry into a durable lifecycle service. A submission now produces a stable **Event → Run → Step → Attempt** projection. The service supports approval, typed retries, operator actions, newer Event handling, and restart reconciliation.

The implementation has three review-critical boundaries:

- Effect Workflow owns resumable execution and derives its execution identity from the Event dedup key.
- `RunStore` commits lifecycle state and pending workflow commands in SQLite transactions.
- The root package entry stays platform-free. The Node SQLite adapter is a separate subpath export.

The change also adds Drizzle schema and migration artifacts, live SQLite tests, core lifecycle types, a workspace-wide `noUncheckedIndexedAccess` setting, and Effect v4 guidance updates.

{% callout tone="key" %}
The main correctness question is the handoff between a committed projection and its workflow signal. The command journal and startup reconciliation make that handoff replayable after a process stop.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Durable lifecycle" %}
{% section id="event-claim" title="Stable claims and newer Events" icon="git-branch" related=["attempt-loop","restart-reconciliation"] %}
`Submission` carries the Event plus the Item, Loop, Step, and approval route. The public result distinguishes an Event that owns a Run, an Event queued behind a running Attempt, and an Event that can no longer open a Run.

{% code file="packages/engine/src/model.ts" from=13 to=64 expect="/** The complete routing context needed to turn one Event into a Run. */" /%}

`RunEngine.submit()` first derives the workflow Run ID. `RunStore.recordAndClaim()` then makes the routing decision in one database transaction:

1. A previously claimed Event joins its existing Run.
2. An ignored Event returns its stored reason.
3. With no open Run for the same Loop and Item, the Event opens a Run.
4. A running Attempt keeps control, so the new Event remains queued.
5. A pending or waiting Run is superseded before the new Run opens.

{% code file="packages/engine/src/store/store.ts" from=79 to=132 expect="  const recordAndClaim = Effect.fn(\"RunStore.recordAndClaim\")(function* (" /%}

The Event table has a unique dedup key. On conflict, the query reloads the original route rather than accepting routing fields from a later duplicate. When a running Attempt closes, `nextQueued()` selects the newest unclaimed Event by `receivedAt`; opening that Run marks the other unclaimed Events for the same Loop and Item as superseded.

{% code file="packages/engine/src/store/queries.ts" from=341 to=395 expect="  const recordTriggerEvent = Effect.fn(\"RunStoreQueries.recordTriggerEvent\")(function* (" /%}
{% /section %}

{% section id="attempt-loop" title="Approval and Attempt loop" icon="iterations" related=["event-claim","restart-reconciliation"] %}
The workflow uses the Event dedup key as its idempotency key and suspends on terminal failure. An approval requirement parks the Run before any Attempt and waits on a durable deferred gate.

After the gate opens, the workflow repeatedly asks the store to begin an Attempt, calls `StepExecutor.execute()`, and commits the outcome. Only an infrastructure failure can continue the loop automatically. The cap is three total Attempts. Agent and runaway failures suspend until an operator calls `retry()`.

A defect that escapes the executor adapter is translated to `InfraFailure`. This keeps adapter crashes in the declared failure channel and lets the normal retry rule handle them.

```pseudo
execute durable Run
  if approval required
    persist Waiting
    await approval Event
  repeat
    atomically open Attempt N
    call StepExecutor
    if success
      close Attempt and Run
      open newest queued Event
    if failure is retryable and N < 3
      continue as Attempt N+1
    otherwise
      persist Failed
      suspend for operator
```

{% code file="packages/engine/src/workflow.ts" from=19 to=115 expect="export const DurableRun = Workflow.make(\"@usine/engine/DurableRun\", {" collapsed=true /%}

The core model now includes a canceled Attempt outcome and keeps the retry rule in one pure function. `AttemptNumber` is a positive branded integer, so the database projection and engine use the same 1-based count.

{% code file="packages/core/src/lifecycle/attempt.ts" from=17 to=65 expect="export const AttemptNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(" /%}
{% /section %}

{% section id="restart-reconciliation" title="Replay after interruption" icon="sync" related=["event-claim","attempt-loop"] %}
Projection changes that need a workflow action also insert a command: `Approve`, `Resume`, `Interrupt`, or `Continue`. The command remains until delivery succeeds. Replay sorts commands per Run so `Resume` precedes `Interrupt`, and `Interrupt` precedes `Continue`; this prevents a canceled workflow from overlapping the next queued Run.

At layer construction, `RunEngine.reconcile()` first delivers pending commands. It then checks every open projection against Effect Workflow:

- A complete workflow repairs an unfinished Attempt and Run projection.
- A suspended workflow with a running projection resumes.
- An absent workflow starts again with the same deterministic identity.

{% code file="packages/engine/src/engine.ts" from=136 to=165 expect="  const reconcile = Effect.fn(\"RunEngine.reconcile\")(function* () {" /%}

If the process stopped with an open Attempt, `beginAttempt()` closes that Attempt as an infrastructure failure. It then starts Attempt N+1 when the retry budget permits. Success, failure, Step result, Run state, and the follow-up command are each committed in the same transaction.

{% code file="packages/engine/src/store/store.ts" from=146 to=257 expect="  const beginAttempt = Effect.fn(\"RunStore.beginAttempt\")(function* (runId: Run.RunId) {" collapsed=true /%}

An immediate operator retry has an extra race boundary: the Failed projection can commit before Effect Workflow finishes suspending. Resume delivery polls for workflow settlement. It reconciles an already complete workflow or resumes a suspended one, and fails loudly if no execution appears within the bounded polling window.

{% code file="packages/engine/src/engine.ts" from=54 to=79 expect="  const awaitWorkflowSettlement = Effect.fn(\"RunEngine.awaitWorkflowSettlement\")(function* (" /%}
{% /section %}
{% /group %}

{% group label="SQLite projection" %}
{% section id="projection-schema" title="Constraints and boundary decoding" icon="database" related=["database-composition"] %}
Drizzle now owns the SQLite projection schema and generated migration. The schema enforces one Event per dedup key, one Run per Event, one Attempt number per Step, and at most one open Attempt per Run. Approval Events are also unique, and workflow commands use `(runId, command)` as their primary key.

{% code file="packages/engine/src/database/schema.ts" from=80 to=105 expect="export const attempts = snakeCase.table(" /%}

Drizzle `$type` declarations do not validate runtime rows. The codec therefore decodes Run state, Attempt outcome, dates, branded identifiers, ignored reasons, and workflow commands through Effect Schema. Database and decoding failures are translated to `EnginePersistenceError` with the operation name.

{% code file="packages/engine/src/store/codec.ts" from=24 to=79 expect="export const RunRow = Schema.Struct({" /%}

The core package also exports compile-checked open and unstarted state-tag sets. SQL filters borrow these sets, so the persisted query partitions must stay complete when the domain union changes.
{% /section %}

{% section id="database-composition" title="Platform-free engine composition" icon="cloud" related=["projection-schema"] %}
`RunEngine` exposes a declared service contract. `layerWithDatabase()` accepts a layer that provides both the driver-neutral Drizzle database and the matching Effect `SqlClient`. The latter lets the Run projection and Effect Cluster tables share one database. The caller still provides `Crypto` and `StepExecutor`.

{% code file="packages/engine/src/engine.ts" from=175 to=224 expect="export class RunEngine extends Context.Service<" /%}

The Node-only adapter creates `<instance>/.usine/runtime.sqlite`, enables foreign keys, and applies the committed Drizzle migrations through the `usine_migrations` ledger. It is exported from `@usine/engine/local-sqlite`, not from the root entry.

{% code file="packages/engine/src/database/local-sqlite.ts" from=19 to=53 expect="  Layer.unwrap(" /%}

{% callout tone="warn" %}
Cloudflare D1 is an explicit target, but it is not supported in this change. ADR 0020 records that Drizzle RC.4 cannot provide the atomic Effect transactions and runtime migration path that this store requires. The PR also carries a narrow Drizzle compatibility patch for the pinned Effect RC.
{% /callout %}
{% /section %}
{% /group %}

{% group label="Verification" %}
{% section id="runtime-tests" title="Lifecycle and crash evidence" icon="beaker" %}
The tests use the public service with a temporary, live SQLite database and a scripted `StepExecutor`. They assert snapshots and persisted outcomes rather than executor call counts.

{% tests %}
{% test name="success, deduplication, and approval" kind="unit" ref="packages/engine/test/engine.test.ts" asserts=["stores one successful Attempt and Step result", "returns the same Run for a duplicate dedup key", "keeps approval delivery idempotent"] %}These scenarios cover the normal lifecycle and the durable approval gate.{% /test %}
{% test name="failure policy" kind="unit" ref="packages/engine/test/engine.test.ts" asserts=["retries typed infrastructure failures", "translates executor defects to infrastructure failures", "stops automatic retry at three Attempts", "waits for operator retry after an agent failure"] %}The tests also retry immediately after the Failed projection appears, which exercises the workflow-settlement race.{% /test %}
{% test name="newer Events and cancellation" kind="unit" ref="packages/engine/test/engine.test.ts" asserts=["supersedes and revokes only unstarted Runs", "lets a running Attempt finish", "opens only the newest queued Event", "records operator cancellation atomically"] %}These cases verify the Item-level ordering rules and explicit canceled Attempt outcome.{% /test %}
{% test name="runtime restart" kind="unit" ref="packages/engine/test/engine.test.ts" asserts=["keeps an approval wait parked", "repairs an open Attempt as an infrastructure failure", "continues with Attempt N+1", "co-locates usine and cluster tables"] %}The test closes and rebuilds the runtime over the same database to exercise startup reconciliation.{% /test %}
{% test name="atomic retry cap and domain construction" kind="unit" ref="packages/engine/test/store.test.ts" asserts=["commits the third failed Attempt with the Failed Run state"] %}The store test checks the transaction boundary directly. Core tests also reject invalid Attempt numbers, empty identifiers, and Event payloads that SQLite cannot preserve as JSON.{% /test %}
{% /tests %}
{% /section %}
{% /group %}

{% group label="Full PR diff" %}
{% section id="full-pr-diff" title="Full PR diff" icon="file-diff" %}
{% files %}
{% filegroup label="Generated database artifacts" only="{packages/engine/drizzle/**,packages/engine/drizzle.config.ts}" /%}
{% filegroup label="Engine runtime and tests" only="{packages/engine/src/**,packages/engine/test/**,packages/engine/README.md,packages/engine/package.json,packages/engine/tsconfig.check.json}" /%}
{% filegroup label="Core lifecycle" only="packages/core/**" /%}
{% filegroup label="Architecture and release notes" only="{docs/**,.changeset/**}" /%}
{% filegroup label="Agent guidance" only="{.agents/**,AGENTS.md}" /%}
{% filegroup label="Workspace and dependencies" /%}
{% /files %}
{% /section %}
{% /group %}
