# @usine/engine

The durable run engine for [usine](https://github.com/basaltbytes/usine). It turns a synthetic Event into a Run with one named Step and a durable Attempt history.

The default adapter stores usine's Event ledger and Run projections beside Effect's workflow tables in `<instance>/.usine/runtime.sqlite`. Submitting the same dedup key joins the original Run, including after a restart.

`CursorStore` keeps typed keys with JSON values in that database. Trigger adapters use it for efficiency-only cursors such as GitHub watermarks and ETags; deleting a cursor causes a safe replay because the Event ledger remains the source of deduplication.

`LoopControl` keeps runtime pause state in the same database. Pausing or unpausing a Loop never edits its authored Markdown file. `RunReader.list()` returns lightweight durable Run summaries newest first for observe-and-intervene surfaces, without loading Event payloads or issuing one snapshot read per Run. `RunReader.revision()` lets callers reuse an unchanged projection without rescanning history.

`ItemProjectionReader` and `ItemProjectionWriter` store the latest issue and pull-request snapshots already fetched by trigger polling. Board consumers can read that projection after a restart without making a second GitHub query; `ItemProjectionReader.list` returns the newest Items first, bounded by the caller's `limit`. Item writes update the shared projection revision only when the content hash changes.

`RepositoryLabelProjectionReader` and `RepositoryLabelProjectionWriter` store the complete label catalog observed during repository polling. Repositories with no Items can still receive proposed Board lanes, and the catalog remains available after a restart. Catalog writes update the projection revision only when the label set changes.

## Runtime rules

- Approval-gated Runs wait for an approval Event before their first Attempt.
- Infrastructure failures retry automatically, with a cap of three Attempts. Agent and runaway failures wait for an operator retry.
- A newer Event supersedes a pending or waiting Run. A running Attempt finishes first, then the engine opens only the newest queued Event for that Item.
- Revoke stops pending and waiting Runs. Operator cancellation can also stop a running Attempt.
- The startup sweep rejoins open workflow executions. If the process stopped during an Attempt, the engine records that Attempt as an infrastructure failure and resumes as N+1.
- A crash inside the `StepExecutor` adapter is recorded as an infrastructure failure like any other. If the engine itself hits an invariant defect, the workflow suspends for inspection; `RunEngine.reconcile` (or a restart) repairs the projection.
- Attempt channel envelopes are stored in an append-only transcript. Durable protocol-v3 envelopes remain readable after the live channel upgrades to v4. Normalized parent and child session events retain their session identity. `RunEngine.transcript` accepts distinct `TranscriptAllQuery`, `TranscriptTailQuery`, and `TranscriptPageQuery` variants, so full diagnostics, bounded live tails, and bounded backward pages cannot be confused. Tail and page queries require a positive row limit. A protocol-v4 `Started` frame writes the SDK-selected parent model onto the Attempt.
- The submitted agent, rendered task, payload snapshot, effective parent model, and per-Attempt child brain survive restarts in the run ledger.

## Composition

Every subpath is platform-free except the Node local adapter at `@usine/engine/local-sqlite`. Its `layer` supplies local SQLite, Effect `SingleRunner`, workflow registration, and startup reconciliation. Provide a `StepExecutor` implementation at the composition root:

```ts
import { Effect, Layer } from "effect"
import { WorkerName } from "@usine/core/ids"
import { InstanceDirectory } from "@usine/core/instance"
import { StepResult } from "@usine/core/step/result"
import { StepExecutor } from "@usine/engine/step-executor"
import { layer } from "@usine/engine/local-sqlite"

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

`layerWithDatabase` (from the root entry) accepts another SQLite-compatible database layer. That layer must provide both `RunDatabase` and the matching Effect `SqlClient`, preserving atomic transactions and keeping the run projections beside Effect's cluster tables; the deployment also supplies its platform `Crypto` layer, which the cluster uses to hash over-length deduplication keys. Cloudflare D1 is not supported by Drizzle RC.4 for this use yet because its Effect driver cannot execute the store's transactions.

The Drizzle schema is the source of truth for usine tables. After changing it, generate and review a migration with:

```sh
pnpm --filter @usine/engine db:generate --name <migration_name>
```

Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.
