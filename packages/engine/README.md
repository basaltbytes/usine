# @usine/engine

The durable run engine for [usine](https://github.com/basaltbytes/usine). It turns a synthetic Event into a Run with one named Step and a durable Attempt history.

The default adapter stores usine's Event ledger and Run projections beside Effect's workflow tables in `<instance>/.usine/runtime.sqlite`. Submitting the same dedup key joins the original Run, including after a restart.

`CursorStore` keeps typed keys with JSON values in that database. Trigger adapters use it for efficiency-only cursors such as GitHub watermarks and ETags; deleting a cursor causes a safe replay because the Event ledger remains the source of deduplication.

`LoopControl` keeps runtime pause state in the same database. Pausing or unpausing a Loop never edits its authored Markdown file. `RunReader.list()` returns lightweight durable Run summaries newest first for observe-and-intervene surfaces, without loading Event payloads or issuing one snapshot read per Run. `RunReader.forItems(itemKeys)` reads every saved Run and its Attempts for the selected Items, independently of the recent-history window. `RunReader.revision()` lets callers reuse an unchanged projection without rescanning history.

`ItemProjectionReader` and `ItemProjectionWriter` store the latest issue and pull-request snapshots already fetched by trigger polling. Board consumers can read that projection after a restart without making a second GitHub query; `ItemProjectionReader.list` returns the newest Items first, bounded by the caller's `limit`. Item writes update the shared projection revision only when the content hash changes.

`RepositoryLabelProjectionReader` and `RepositoryLabelProjectionWriter` store the complete label catalog observed during repository polling. Repositories with no Items can still receive proposed Board lanes, and the catalog remains available after a restart. Catalog writes update the projection revision only when the label set changes.

## Runtime rules

- Approval-gated Runs wait for an approval Event before their first Attempt.
- Infrastructure failures retry automatically, with a cap of three Attempts. Agent and runaway failures wait for an operator retry.
- A newer Event supersedes a pending, waiting, or queued Run. A running Attempt finishes first, then the engine opens only the newest queued Event for that Item.
- Revoke stops pending, waiting, and queued Runs. Operator cancellation can also stop a running Attempt.
- The startup sweep rejoins open workflow executions. If the process stopped during an Attempt, the engine records that Attempt as an infrastructure failure and resumes as N+1.
- A crash inside the `StepExecutor` adapter is recorded as an infrastructure failure like any other. If the engine itself hits an invariant defect, the workflow suspends for inspection; `RunEngine.reconcile` (or a restart) repairs the projection.
- Attempt channel envelopes are stored in an append-only transcript. Durable protocol-v3 envelopes remain readable after the live channel upgrades to v4. Normalized parent and child session events retain their session identity. `RunEngine.transcript` accepts distinct `TranscriptAllQuery`, `TranscriptTailQuery`, and `TranscriptPageQuery` variants, so full diagnostics, bounded live tails, and bounded backward pages cannot be confused. Tail and page queries require a positive row limit. A protocol-v4 `Started` frame writes the SDK-selected parent model onto the Attempt.
- The submitted agent, rendered task, payload snapshot, effective parent model, and per-Attempt child brain survive restarts in the run ledger.

The engine's [lifecycle decisions](src/engine/lifecycle.ts) determine Attempt completion, interrupted-Attempt recovery, cancellation, operator retry, and whether a new Event can replace a Run. `RunStore` reads the current records and applies each decision in one transaction, including the Step result and pending workflow commands. Normal completion and restart recovery share the three-Attempt retry cap; reconciliation from a final workflow result closes a typed failure without retrying it. Late executor results cannot settle a replacement Attempt. Effect Workflow continues to own durable execution and signal delivery, as described in [ADR 0003](../../docs/adr/0003-durable-execution-on-effect-workflow.md).

## Composition

Every subpath is platform-free except the Node local adapter at `@usine/engine/local-sqlite`. Its `layer` supplies local SQLite, Effect `SingleRunner`, workflow registration, and startup reconciliation. Provide a `StepExecutor` implementation at the composition root:

```ts
import { Effect, Layer } from "effect"
import { WorkerName } from "@usine/core/worker"
import { InstanceDirectory } from "@usine/core/instance"
import { StepResult } from "@usine/core/step/result"
import { StepExecutor } from "@usine/engine/step-executor"
import { layer } from "@usine/engine/local-sqlite"
import { RunEngine } from "@usine/engine/engine"
import { CursorStore } from "@usine/engine/cursor"
import { LoopControl } from "@usine/engine/loop-control"

const StepExecutorLive = Layer.succeed(StepExecutor)({
  reserve: () => Effect.succeed({
    worker: WorkerName.make("local"),
    release: Effect.void,
  }),
  execute: ({ event }) => Effect.succeed(new StepResult({
    message: `Handled ${event.id}`,
    facts: [],
  })),
  interrupt: () => Effect.void,
})

const EngineLive = layer(InstanceDirectory.make("/path/to/instance")).pipe(
  Layer.provide(StepExecutorLive),
)

const program = Effect.gen(function* () {
  const engine = yield* RunEngine
  const cursors = yield* CursorStore
  const loops = yield* LoopControl
  // submit, approve, retry, cancel, revoke, inspect, reconcile, read a transcript,
  // list runs, pause/unpause loops, or read and write efficiency-only cursors
})
```

`@usine/engine/engine` provides `RunEngine`, `Submission`, submission results, and typed engine errors. `@usine/engine/run-reader` provides `RunReader` and its snapshot and summary types; `/transcript` provides transcript entries, sequence values, and query variants. Import projection contracts from `/item-projection` and `/repository-label-projection`, and loop pause state with `LoopControl` from `/loop-control`.

`layerWithDatabase` from `@usine/engine/engine` accepts another SQLite-compatible database layer. That layer must provide both `RunDatabase` from `@usine/engine/database` and the matching Effect `SqlClient`, preserving atomic transactions and keeping the run projections beside Effect's cluster tables; the deployment also supplies its platform `Crypto` layer, which the cluster uses to hash over-length deduplication keys. Cloudflare D1 is not supported by Drizzle RC.4 for this use yet because its Effect driver cannot execute the store's transactions.

The Drizzle schema is the source of truth for usine tables. After changing it, generate and review a migration with:

```sh
pnpm --filter @usine/engine db:generate --name <migration_name>
```

Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.

`CycleBudgets` at `@usine/engine/cycle-budget` persists Item-level exhaustion Asks and explicit, idempotent reset Events. `Submission.cycleLimit` defaults to three; schedule adapters supply `None`. Run admission reserves the allowance transactionally and returns `CycleBlocked` when the Item needs a reset. Attempt retries do not charge again, and canceled Runs without Attempts return their reservation. Existing history and queued Item Events acquire the default budget on upgrade.

Reset records a fresh polling request. Trigger adapters capture `CycleBudgets.generation(itemKey)` before fetching input and include it in both `Submission.cycleGeneration` and the Event identity. Older observations are superseded at admission, including in-flight polls and queued Events; fresh polling creates a new Event with current execution settings. Labels, restarts, and Loop configuration changes never clear an Ask. See [ADR 0022](../../docs/adr/0022-item-cycle-budgets-and-comment-reviews.md).

`RunEngine.drain()` permanently closes Attempt admission for that runtime and waits for admitted Attempts to persist their outcomes. Worker reservations, approval gates, and subsequent retries resume after restarting the runtime. Interrupting the drain wait keeps admission closed. The host supplies a shutdown deadline and closes its runtime scope after the wait; see [ADR 0023](../../docs/adr/0023-graceful-attempt-drain.md).

Hosts that handle shutdown during startup can provide `RunEngineShutdown` from `/engine`: a fresh `Deferred<void>` allocated before building the runtime. Completing it immediately closes Attempt admission, including recovered work. After startup completes, `RunEngine.drain()` waits for the admitted outcomes. The server installs this protection before building its runtime.
