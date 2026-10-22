# @usine/engine

The durable run engine for [usine](https://github.com/basaltbytes/usine). It turns a synthetic Event into a Run with one named Step and a durable Attempt history.

The default adapter stores usine's Event ledger and Run records in `<instance>/.usine/runtime.sqlite`. A Run's id is a hash of its Event's dedup key, so submitting the same dedup key joins the original Run, including after a restart.

`CursorStore` keeps typed keys with JSON values in that database. Trigger adapters use it for efficiency-only cursors such as GitHub watermarks and ETags; deleting a cursor causes a safe replay because the Event ledger remains the source of deduplication.

`LoopControl` keeps runtime pause state in the same database. Pausing or unpausing a Loop never edits its authored Markdown file. `RunReader.list()` returns lightweight durable Run summaries newest first for observe-and-intervene surfaces, without loading Event payloads or issuing one snapshot read per Run. `RunReader.closed({ limit })` returns the settled Runs that closed last, by the end of their last Attempt, whenever they opened. `RunReader.forItems(itemKeys)` reads every saved Run and its Attempts for the selected Items, independently of the recent-history window. `RunReader.events(runIds)` reads, in one batch, the Event each selected Run was opened for: its payload is the Item as the trigger saw it, so a caller can tell where a Run came from after its Agent changed the Item. `RunReader.revision()` lets callers reuse an unchanged projection without rescanning history.

`ItemProjectionReader` and `ItemProjectionWriter` store the latest issue and pull-request snapshots already fetched by trigger polling. Board consumers can read that projection after a restart without making a second GitHub query; `ItemProjectionReader.list` returns the newest Items first, bounded by the caller's `limit`, and `ItemProjectionReader.openIssues` returns the numbers of every open issue not marked gone. Item writes update the shared projection revision only when the content hash changes.

`RepositoryLabelProjectionReader` and `RepositoryLabelProjectionWriter` store the complete label catalog observed during repository polling. Repositories with no Items can still receive proposed Board lanes, and the catalog remains available after a restart. Catalog writes update the projection revision only when the label set changes.

`BoardMoves` (`@usine/engine/board-moves`) keeps the operator's Board moves: for each, the repository, the Item, when the factory sent it, the source and destination lanes, and the labels added and removed. The orchestrator records a move before it sends the labels, so a label change the factory's App made for the operator is not taken for an Agent's. `BoardMoves.onItem(itemKey, since)` returns an Item's moves from `since` on, oldest first. Moves do not change the projection revision.

## Runtime rules

- Approval-gated Runs wait for an approval Event before their first Attempt.
- Infrastructure failures retry automatically, with a cap of three Attempts. Agent, defect, and guard failures wait for an operator retry. `RunEngine.retry(runId, request)` takes a `RetryRequest`: the operator login that asked and the task and Agent an edit-and-retry amends. Each Attempt records why it began as `Attempt.start`: from the Event, an operator retry or edit and retry with that login, an infrastructure retry, or a restart that interrupted the previous Attempt. A reattached Attempt keeps its reason and records `reattachedAt`.
- A newer Event supersedes a pending, waiting, or queued Run. A running Attempt finishes first, then the engine opens only the newest queued Event for that Item. Before that Event opens, `TriggerCondition` (`@usine/engine/trigger-condition`, supplied by the deployment) re-evaluates the Loop's trigger against the Item's current state: an Event whose trigger no longer holds is recorded as ignored (revoked) and never opens a Run, so a Run that changes its own Item before it flips the labels gating its trigger does not spawn a second Run. When the check answers that the Item's source no longer has it, the Events are revoked the same way and `ItemProjectionWriter.markGone` records the Item as gone, so the Board stops showing it as open.
- Revoke stops pending, waiting, and queued Runs. Operator cancellation can also stop a running Attempt.
- The engine records what each Loop last saw of an Item: the Event a trigger submitted, or a sighting that did not match. A canceled, superseded, or revoked Run keeps its Event while the Item stays in that state, and so does a queued Event that a revoke ignored. When the Loop saw the Item not matching or with other content and the Item then comes back, the Event opens again as a reopening whose dedup key is `["reopened", n, <original key>]`, so its Run has its own id and existing Run ids do not change. Succeeded and failed Runs always keep their Event, and a queued Event that a newer Event superseded stays ignored.
- `RunEngine.runAgain(runId, request)` opens a new Run for the Item state of a succeeded or canceled Run, with the request's task, Agent, Step, approval requirement, and cycle limit. Its Event has the dedup key `["operator-run-again", n, <trigger key>]`, numbered with the trigger Event's reopenings, so a later sighting of the unchanged Item joins the new Run. The Item's cycle budget can block it (`CycleBlocked`), and the Loop's approval gate applies once it opens. It fails with `RunOperationRejectedError` for a Run in another state and `RunRetryBlockedError` while another Run of the Loop is open on the Item. `RunSnapshot.runAgain` names the Run that was run again and who asked.
- An Attempt that ends with `QuestionFailure` or `BlockedFailure` holds its Loop on the Item. The first Event the Loop sees after the question or blocker, usually the Agent's own comment, returns `Held` and opens no Run, and the Item's queued Events wait. An Event with other content, a sighting that does not match, an operator retry, or `RunEngine.resolveFailure` ends the hold; resolving also gives the newest queued Event its turn.
- Each open Run has one fiber in the engine's process, and the run tables are the only durable state. At startup, and then every `ReconcileInterval` (three minutes unless provided otherwise), the engine starts a fiber for every open Run that has none, except a Run waiting for its approval, and opens the newest queued Event of an Item whose Run closed before that Event got its turn. If the process stopped during an Attempt, the engine asks `StepExecutor.isLive` whether the Attempt's parent task outlived the restart. A live Attempt is reattached: it keeps its identity, number, and Worker, spends no retry, and `StepExecution.reattach` tells the executor to take over its checkout. Its Run holds a slot on the Worker where the Attempt runs. At startup, before any Run's fiber starts, the engine occupies that slot through `StepExecutor.occupy` for each open Attempt whose checkout it keeps, so no new Attempt takes it while the Run asks `isLive`. The Run reattaches the Attempt in that slot, which is released when the Attempt ends. When the Run does not reattach the Attempt, the reattachment fails before the execution runs `ExecutionSink.checkoutAcquired`, or the operator cancels the Run before then, the slot is released only once `StepExecutor.interrupt` confirms that the parent task stopped. Until then no new Attempt takes it. For a canceled Run, each reconcile tries the stop again. After another restart, startup stops the parent task of each closed Attempt before `StepExecutor.recover`. When `interrupt` can't confirm that stop, as for a canceled Run whose stop was unconfirmed when the process stopped, the engine keeps the checkout and occupies a slot of the Attempt's Worker, and each reconcile tries the stop again. A Run that reattaches an Attempt without such a slot passes the Attempt's Worker to `StepExecutor.reserve`, and asks `isLive` again once it holds the slot. When the parent task already finished and `StepExecutor.outcome` returns the result it stored, the engine finishes the Attempt with that result, as if the process had not stopped. Otherwise the engine records that Attempt as an infrastructure failure and resumes as N+1.
- At startup, before any Run's fiber starts, the engine passes every persisted Attempt on a Worker in `StepExecutor.workers` to `StepExecutor.recover`, which records its salvage and reconciles its checkout. The exception is an open Attempt whose parent task `StepExecutor.isLive` reports live, or whose liveness cannot be read: its checkout stays for the Run to reattach. The engine still owns that checkout's recovery until the execution that reattaches the Attempt runs `ExecutionSink.checkoutAcquired`, which `StepExecutor.execute` runs once preparation holds the checkout, and never when preparation fails; the executor releases it from then on. When the Run closes the Attempt before then, because its parent task stopped before the Run reserved a Worker, the Run cannot read whether it is live, the reattachment failed first, or the operator canceled the Run, the engine first stops its parent task through `StepExecutor.interrupt`, then passes it to `StepExecutor.recover`. `recover` reconciles the checkout whatever `isLive` reports, since the Run already decided. The Attempt is still open when its Run's fiber reconciles it, as at startup, so the next Attempt resumes from that salvage. When `interrupt` cannot confirm that the parent task stopped, the checkout stays and the Run's fiber stops before the next Attempt starts, logging `Could not confirm that the parent task of an Attempt its Run does not reattach stopped`. The next reconcile drives the Run again: it reattaches the Attempt if its parent task is live, or tries the stop and the reconcile again.
- The Attempts recorded on a Worker that `StepExecutor.workers` doesn't list stay unreconciled. `RunReader.attemptsByWorker()` counts, per Worker, the Attempts startup still visits and how many of them are open, without an outcome yet. `RunEngine.discardLeftovers(worker)` stops tracking a Worker's Attempts and changes nothing on the Worker. For a Worker that `StepExecutor.workers` lists, a declared one or a removed one until its last Attempt ends, it fails with `LeftoversDiscardRejectedError`, which names the Worker and counts its open Attempts.
- A defect escaping `StepExecutor` is saved as `DefectFailure`, preserving its original cause and requiring an operator retry. A store operation that fails to persist is repeated four times with exponential backoff before it counts as failed. If the engine itself fails while driving a Run (a defect, or a write the store still could not make), that Run's fiber logs the cause and stops; the next reconcile or a restart starts it again from the tables.
- Attempt channel envelopes are stored in an append-only transcript. A redelivered envelope (same Attempt, direction, and channel sequence, as a reattached parent may send after a restart) keeps the first stored copy. Stored protocol-v3 through v6 envelopes remain readable after the live channel upgrades to v7. Normalized parent and child session events retain their session identity. `RunEngine.transcript` accepts distinct `TranscriptAllQuery`, `TranscriptTailQuery`, and `TranscriptPageQuery` variants, so full diagnostics, bounded live tails, and bounded backward pages cannot be confused. `TranscriptUsageQuery` returns each session's highest `SessionTokensUpdated` report, wherever it sits in the transcript. Tail and page queries require a positive row limit. A protocol-v4 `Started` frame writes the SDK-selected parent model onto the Attempt.
- The submitted agent, rendered task, payload snapshot, effective parent model, and per-Attempt child brain survive restarts in the run ledger.
- The sink a Run's fiber gives `StepExecutor.execute` reads, as `windows`, the Attempt's own window on the Run's Item and the windows of the other Attempts of its Agent that overlap it there (`RunStore.attemptWindows`), and so does the `RecoverySink` startup reconciliation passes to `StepExecutor.recover`. The harvest reads them once GitHub has listed the Attempt's comments. An Attempt that started after this one, even while the harvest ran, therefore counts too, and so does the end recorded when a cancel closed this Attempt before its executor stopped. The harvest keeps only a comment posted inside the own window and in none of the others ([ADR 0006](../../docs/adr/0006-executor-contract-run-host-attempt-channel.md), #429). An Attempt that ended before end times were recorded has no known window: it has no own window, so its harvest keeps no comment, and it is not listed as another Attempt's overlapping window. The sink also reads back, as `transcript`, the envelopes stored for the Attempt in the current protocol version, in append order (`TranscriptAllQuery`), so an executor that reattaches the Attempt after a restart resumes its runaway guard from them.

The engine's [lifecycle decisions](src/engine/lifecycle.ts) determine Attempt completion, interrupted-Attempt recovery, cancellation, operator retry, and whether a new Event can replace a Run. `RunStore` reads the current records and applies each decision in one transaction, including the Step result. Normal completion and restart recovery share the three-Attempt retry cap. Late executor results cannot settle a replacement Attempt. Approval, retry, cancellation, supersede, and revoke commit through the store and then start or stop the Run's fiber; [ADR 0003](../../docs/adr/0003-durable-execution-on-effect-workflow.md) records why the engine drives Runs itself.

## Composition

Every subpath is platform-free except the Node local adapter at `@usine/engine/local-sqlite`. Its `layer` supplies local SQLite, the migrations, and startup recovery. Provide a `StepExecutor` implementation at the composition root:

```ts
import { Effect, Layer, Option } from "effect"
import { WorkerName } from "@usine/core/worker"
import { InstanceDirectory } from "@usine/core/instance"
import { StepResult } from "@usine/core/step/result"
import { StepExecutor } from "@usine/engine/step-executor"
import { TriggerCondition } from "@usine/engine/trigger-condition"
import { layer } from "@usine/engine/local-sqlite"
import { RunEngine } from "@usine/engine/engine"
import { CursorStore } from "@usine/engine/cursor"
import { LoopControl } from "@usine/engine/loop-control"

const StepExecutorLive = Layer.succeed(StepExecutor)({
  isLive: () => Effect.succeed(false),
  outcome: () => Effect.succeed(Option.none()),
  recover: () => Effect.void,
  intervene: () => Effect.void,
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

// Re-checks a queued Event's trigger before its Run opens; this one always matches.
const TriggerConditionLive = Layer.succeed(TriggerCondition)({
  recheck: () => Effect.succeed("matches"),
})

const EngineLive = layer(InstanceDirectory.make("/path/to/instance")).pipe(
  Layer.provide(StepExecutorLive),
  Layer.provide(TriggerConditionLive),
)

const program = Effect.gen(function* () {
  const engine = yield* RunEngine
  const cursors = yield* CursorStore
  const loops = yield* LoopControl
  // submit, approve, retry, cancel, revoke, inspect, reconcile, read a transcript,
  // list runs, pause/unpause loops, or read and write efficiency-only cursors
})
```

`@usine/engine/engine` provides `RunEngine`, `Submission`, submission results, and typed engine errors. `@usine/engine/run-reader` provides `RunReader` and its snapshot, summary, Run Event, and evidence types; `/transcript` provides transcript entries, sequence values, and query variants. Import projection contracts from `/item-projection` and `/repository-label-projection`, and loop pause state with `LoopControl` from `/loop-control`.

`RunReader.evidence(runId)` reads the Run snapshot and every transcript entry for its Attempts in one database transaction. The returned `RunEvidence` stays consistent when an Attempt completes or appends output during the read. Transcript entries use append order with no page limit.

For local maintenance commands, `runReaderLayer(instanceDirectory)` from `@usine/engine/local-sqlite` provides only `RunReader` using a read-only SQLite connection. It requires an existing runtime database and does not initialize tables, migrate the schema, or change the journal mode. A missing, unreadable, or incompatible database fails through `EnginePersistenceError`.

`backup(instanceDirectory, destination)` from `@usine/engine/local-sqlite` copies every runtime table and committed WAL data while other connections remain active. It opens the source read-only, without migrations. The destination must be a new file in an existing directory that supports hard links; the adapter saves a complete owner-only copy without overwriting existing files.

`RuntimeStoreBackupError` includes the failed operation (`open`, `stage`, `copy`, or `publish`), both paths, and the underlying error message or code. Structured logs report failures and the number of pages copied on success. If interrupted, the adapter waits for Node's backup to finish before closing its connection and deleting temporary files.

`layerWithDatabase` from `@usine/engine/engine` accepts another SQLite-compatible database layer. That layer provides `RunDatabase` from `@usine/engine/database` with atomic transactions; the deployment also supplies its platform `Crypto` layer, which hashes dedup keys into Run ids. Cloudflare D1 is not supported by Drizzle RC.4 for this use yet because its Effect driver cannot execute the store's transactions.

The Drizzle schema is the source of truth for usine tables. After changing it, generate and review a migration with:

```sh
pnpm --filter @usine/engine db:generate --name <migration_name>
```

Everything is 0.x, so APIs may change. Supply `effect` at the version pinned by the usine workspace.

`CycleBudgets` at `@usine/engine/cycle-budget` persists Item-level exhaustion Asks and explicit, idempotent reset Events. `Submission.cycleLimit` defaults to three; schedule adapters supply `None`. Run admission reserves the allowance transactionally and returns `CycleBlocked` when the Item needs a reset. Attempt retries do not charge again, and canceled Runs without Attempts return their reservation. Existing history and queued Item Events acquire the default budget on upgrade.

Reset records a fresh polling request. Trigger adapters capture `CycleBudgets.generation(itemKey)` before fetching input and include it in both `Submission.cycleGeneration` and the Event identity. Older observations are superseded at admission, including in-flight polls and queued Events; fresh polling creates a new Event with current execution settings. Labels, restarts, and Loop configuration changes never clear an Ask. See [ADR 0022](../../docs/adr/0022-item-cycle-budgets-and-comment-reviews.md).

`RunEngine.drain()` permanently closes Attempt admission for that runtime and waits for admitted Attempts to persist their outcomes. Worker reservations, approval gates, and subsequent retries resume after restarting the runtime. Interrupting the drain wait keeps admission closed. The host supplies a shutdown deadline and closes its runtime scope after the wait; see [ADR 0023](../../docs/adr/0023-graceful-attempt-drain.md).

Hosts that handle shutdown during startup can provide `RunEngineShutdown` from `/engine`: a fresh `Deferred<void>` allocated before building the runtime. Completing it immediately closes Attempt admission, including recovered work. After startup completes, `RunEngine.drain()` waits for the admitted outcomes. The server installs this protection before building its runtime.

Stored protocol-v5 envelopes remain readable after upgrading the live channel to v6. Session transcript queries retain each session's launch record alongside its latest lifecycle state, so saved harness session ids and worker paths remain available after completion and outside the loaded history page.

`RunEngine.resolveFailure(runId, attemptId)` persists resolution for the current failed Attempt. Repeated requests for that same failure are safe; requests for a different Attempt or a Run that is no longer failed are rejected. `RunReader` snapshots and summaries include `resolvedFailureAttemptId`, and resolution updates the projection revision. Run outcomes, Attempts, transcripts, and retry availability remain unchanged.
