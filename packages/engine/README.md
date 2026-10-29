# @usine/engine

The durable run engine for [usine](https://github.com/basaltbytes/usine). It turns a synthetic event into a run with one named step and a durable attempt history. [Run lifecycle](https://docs.usine.dev/architecture/run-lifecycle/) covers these rules in depth.

The default adapter stores the event ledger and run records in `<instance>/.usine/runtime.sqlite`. A run's id is a hash of its event's dedup key, so submitting the same key again joins the original run, also after a restart.

0.x APIs can change. Supply `effect` at the workspace's pinned version.

## Stores and readers

- `CursorStore` stores typed keys with JSON values, for efficiency-only trigger cursors such as GitHub watermarks and ETags. Deleting one safely replays events; the ledger deduplicates.
- `LoopControl` stores loop pause state; pausing never edits the loop file.
- `ItemProjectionReader` and `ItemProjectionWriter` store the latest issue and pull request snapshots from polling, which the board reads after a restart without querying GitHub. `get` returns one item's projection; `list` returns the newest items first, up to `limit`; `openIssues` returns the numbers of open issues not marked gone. Writes change the projection revision only if the content hash changes.
- `RepositoryLabelProjectionReader` and `RepositoryLabelProjectionWriter` store each repo's full label catalog from polling, so repos without items still get proposed lanes. Writes change the revision only if the label set changes.
- `BoardMoves` (`/board-moves`) stores each board move: repo, item, send time, source and destination lanes, and labels added and removed. The orchestrator records a move before sending its labels, so the factory app's label change for the operator isn't taken for an agent's. `onItem(itemKey, since)` returns an item's moves from `since`, oldest first. Moves don't change the revision.

`RunReader`:

- `list()`: lightweight run summaries, newest first, without event payloads or a snapshot read per run.
- `closed({ limit })`: the runs that closed last, by their last attempt's end.
- `forItems(itemKeys)`: every saved run and its attempts for those items, outside the recent-history window.
- `events(runIds)`: in one batch, the event that opened each run. Its payload is the item as the trigger saw it, before the agent changed it.
- `evidence(runId)`: the run snapshot and all its transcript entries, in append order and unpaged, from one transaction, consistent while attempts complete or append.
- `attemptsByWorker()`: per worker, the attempts that startup still visits, and how many are open.
- `revision()`: lets callers reuse an unchanged projection.

## Runtime rules

### Approval and retries

- Approval-gated runs wait for an approval event before their first attempt.
- Infrastructure and provider capacity failures retry automatically, up to three attempts. Capacity retries wait two minutes after attempt 1 and five minutes after attempt 2, without reserving a worker slot. The persisted attempt end time determines the deadline across restarts. Retries resume from the newest pushed salvage, and cancellation stops the wait. Agent, defect, and guard failures wait for an operator retry. A defect escaping `StepExecutor` is saved as `DefectFailure` with its original cause.
- `RunEngine.retry(runId, request)` takes a `RetryRequest`: the operator login and the task and agent that an edit-and-retry changes.
- `Attempt.start` records why each attempt started: the event, an operator retry or edit-and-retry with its login, an infrastructure or provider capacity retry, or a restart. A reattached attempt keeps its reason and records `reattachedAt`.

### Supersede, revoke, and reopening

- A newer event supersedes a pending, waiting, or queued run. A running attempt finishes first; then only the item's newest queued event opens.
- Before it opens, `TriggerCondition` (`/trigger-condition`, supplied by the deployment) re-evaluates the loop's trigger on the item's current state. If it no longer matches, the event is recorded as ignored (revoked) and opens no run. If the item's source no longer has the item, the events are revoked and `ItemProjectionWriter.markGone` marks it gone, so the board stops showing it as open.
- Revoke stops pending, waiting, and queued runs; operator cancel also stops a running attempt. Cancel rejects failed and succeeded runs with `RunOperationRejectedError` and preserves their outcomes. Repeating cancel on a canceled run succeeds without changing it.
- If `StepExecutor.interrupt` can't confirm that a canceled attempt's parent task stopped, `RunEngine.cancel` fails with `AttemptCancellationError`, and the attempt keeps its run's worker slot. After `StepExecutor.execute` fails, the engine also calls `interrupt` before it closes the attempt, and keeps the slot the same way if the stop isn't confirmed. The engine records a pending stop before calling the executor. While the stop is pending or unconfirmed, no loop starts a new attempt on the item, on any worker; the run's fiber ends instead of reserving a slot. Each reconcile retries the stop, with its reason (`cancel`, `failed`, or `startup`) passed to `interrupt`, releases the slot once the stop is confirmed, and then starts the fibers of the waiting runs. `UnconfirmedStops` (`/engine`) lists these attempts with their loop and item, and `UnconfirmedStops.empty` lists none, for a process that drives no run.
- The engine records what each loop last saw of an item: a submitted event, or a non-matching sighting. A canceled, superseded, or revoked run keeps its event while the item stays the same, and so does a queued event that a revoke ignored. If the loop saw the item not matching or changed, and it then matches again, the event reopens with the dedup key `["reopened", n, <original key>]`, so the new run gets its own id.
- Succeeded and failed runs always keep their event. A queued event superseded by a newer one stays ignored.

### Run again

`RunEngine.runAgain(runId, request)` opens a new run for the item state of a succeeded or canceled run, with the request's task, agent, step, approval requirement, and cycle limit. Its dedup key, `["operator-run-again", n, <trigger key>]`, is numbered with the trigger event's reopenings, so a later sighting of the unchanged item joins it. The cycle budget can block it (`CycleBlocked`), and the approval gate applies. It fails with `RunOperationRejectedError` for other states and `RunRetryBlockedError` while the loop has another open run on the item. `RunSnapshot.runAgain` names the original run and who asked.

### Questions, blockers, and resolution

An attempt ending with `QuestionFailure` or `BlockedFailure` starts a suppression of the item for its loop. The loop's next event, usually the agent's own comment, returns `Suppressed` and opens no run; queued events wait. An event with other content, a non-matching sighting, an operator retry, or `RunEngine.resolveFailure` lifts the suppression, and resolving gives the newest queued event its turn.

`RunEngine.resolveFailure(runId, attemptId, operator)` stores the time and operator login of the current failed attempt's resolution in `Attempt.failureResolution`. Pass `Option.none()` if no operator login is configured. Repeats preserve the first resolution time and operator; another attempt or a run no longer failed is rejected. Snapshots and summaries include `resolvedFailureAttemptId`, and resolution updates the revision. The failed outcome and transcript stay in history, and retry remains available.

### Run fibers and restarts

Each open run has one fiber, and the run tables are the only durable state. At startup and every `ReconcileInterval` (three minutes by default), the engine starts a fiber for each open run without one, except runs waiting for approval, and opens the newest queued event of an item whose run closed first. A failed store operation is retried four times with exponential backoff. If the engine fails while driving a run (a defect, or a write that still fails), the fiber logs the cause and stops until the next reconcile or restart.

After a stop during an attempt, the engine asks `StepExecutor.isLive` whether its parent task survived:

- Live: the engine reattaches the attempt, with its identity, number, and worker, using no retry. `StepExecution.reattach` tells the executor to take over the checkout.
- Finished, and `StepExecutor.outcome` returns the stored result: the engine finishes the attempt with it.
- Otherwise: the attempt fails as an infrastructure failure, and the run continues with attempt N+1.

At startup, before any fiber starts, `StepExecutor.occupy` takes a slot on the worker of each open attempt whose checkout the engine keeps, so no new attempt takes it while the run calls `isLive`. The reattached attempt runs in that slot until it ends. If the run doesn't reattach, the reattachment fails before `ExecutionSink.checkoutAcquired`, or the operator cancels, before or after `checkoutAcquired`, the slot stays taken until `StepExecutor.interrupt` confirms that the parent task stopped. A reattaching run without such a slot passes the worker to `StepExecutor.reserve`, then calls `isLive` again.

A recorded `SalvageRetained.pushFailure` ends the attempt with `GitHubPushFailure`, without an automatic retry. Startup recovery also records this diagnostic on an already failed attempt. A later successful salvage keeps the failure history. Canceled attempts stay canceled. A question or blocker still suppresses the item when a push failure replaces its displayed outcome.

Also at startup, the engine passes every stored attempt on a worker in `StepExecutor.workers` to `StepExecutor.recover`, which records its salvage and reconciles its checkout. An attempt whose recorded salvage is `Rejected` carries it in `AttemptRecovery.rejected`, so the recovery doesn't push the same commit again. It first stops the parent task of each closed attempt. An open attempt whose parent task is live, or whose liveness can't be read, keeps its checkout for the run. Each reconcile, the startup one included, ends with `StepExecutor.sweep`, which removes the worker resources that no attempt holds, such as a provisioned worker's machines ([#550](https://github.com/basaltbytes/usine/issues/550)) or the Codex homes that a crash left on an SSH worker ([#592](https://github.com/basaltbytes/usine/issues/592)).

The engine handles that checkout's recovery until the reattaching execution runs `ExecutionSink.checkoutAcquired`, which `StepExecutor.execute` runs once preparation has the checkout, never on a failed preparation. If the run closes the attempt first (the task stopped before the run reserved a worker, liveness can't be read, the reattachment failed, or the operator canceled), the engine stops the parent task with `interrupt` and passes the still-open attempt to `recover`, which reconciles regardless of `isLive`. The next attempt resumes from that salvage.

If `interrupt` can't confirm the stop, the checkout and slot stay, the fiber stops before the next attempt and logs `Could not confirm that the parent task of an Attempt its Run does not reattach stopped`, and each reconcile tries again: it reattaches if the task is live, or retries the stop. This applies after another restart too.

Attempts on a worker that `StepExecutor.workers` doesn't list aren't reconciled. `RunEngine.discardLeftovers(worker)` stops tracking them, then passes them to `StepExecutor.discard`, which removes what they left outside their checkouts, such as their Codex homes on an SSH worker, and never fails. Their checkouts stay. For a listed worker (declared, or removed with attempts still running), it fails with `LeftoversDiscardRejectedError`, which names the worker and counts its open attempts.

### Transcripts

Attempt channel envelopes go to an append-only transcript. A redelivered envelope (same attempt, direction, and channel sequence, as a reattached parent can send) keeps the first copy. Envelopes from protocol v3 to v6 still read under v7. Parent and child session events keep their session identity. A protocol v4 `Started` writes the SDK-selected parent model to the attempt.

`RunReader.latestPoolRateLimits()` reads the newest stored `PoolRateLimitsUpdated` event for each pool by global transcript append order, across all attempts. It queries the existing transcript table through a partial index of rate-limit events, including reports below warning thresholds and reports whose windows have reset.

`RunEngine.transcript` takes distinct query types: `TranscriptAllQuery`, `TranscriptTailQuery` and `TranscriptPageQuery` (bounded, with a positive row limit), and `TranscriptUsageQuery`, which returns each session's highest `SessionTokensUpdated` report. Session queries keep each session's launch record with its latest state, so harness session ids and worker paths stay available after completion and outside the loaded page.

The run ledger keeps the submitted agent, rendered task, payload snapshot, effective parent model, and each attempt's child brain across restarts.

### Attempt windows

The sink given to `StepExecutor.execute`, and the `RecoverySink` given to `StepExecutor.recover`, read as `windows` the attempt's own window on the item and the agent's overlapping windows there (`RunStore.attemptWindows`). The harvest reads them after GitHub lists the comments, so attempts started meanwhile count, as does an end recorded when a cancel closed the attempt before the executor stopped. It keeps only comments inside the own window and no other ([ADR 0006](../../docs/adr/0006-executor-contract-run-host-attempt-channel.md), #429). An attempt that ended before end times were recorded has no window: its harvest keeps no comment, and it overlaps no other attempt.

The sink also reads back the attempt's current-protocol envelopes in append order as `transcript` (`TranscriptAllQuery`), so a reattaching executor resumes its runaway guard.

### Lifecycle decisions

The [lifecycle decisions](src/engine/lifecycle.ts) decide attempt completion, interrupted-attempt recovery, cancellation, operator retry, and whether a new event can replace a run. `RunStore` applies each decision and its step result in one transaction. Completion and restart recovery share the three-attempt cap, and a late executor result can't settle a replacement attempt. Approval, retry, cancel, supersede, and revoke commit through the store, then start or stop the fiber. [ADR 0003](../../docs/adr/0003-durable-execution-on-effect-workflow.md) records why the engine drives runs itself.

## Cycle budgets

`CycleBudgets` (`/cycle-budget`) stores item-level exhaustion asks and idempotent reset events. `Submission.cycleLimit` defaults to three; schedule adapters pass `None`. Admission reserves the allowance in a transaction, or returns `CycleBlocked` if the item needs a reset. Retries don't count again, and canceled runs without attempts give their reservation back. On upgrade, existing history and queued events get the default budget.

A reset records a fresh polling request. Trigger adapters read `CycleBudgets.generation(itemKey)` before fetching and put it in `Submission.cycleGeneration` and the event identity. Admission supersedes older observations, including in-flight polls and queued events, and new polling creates an event with current settings. Labels, restarts, and loop changes never clear an ask. See [ADR 0022](../../docs/adr/0022-item-cycle-budgets-and-comment-reviews.md).

`CycleBudgets.close(askId, "ItemClosed")` closes an ask without a reset, for an item that was closed or merged. It records the ask and the reason in `usine_cycle_ask_closures` and keeps the generation and reservations, so the item's next admission at the limit opens a new ask.

## Drain and shutdown

`RunEngine.drain()` closes attempt admission for good and waits for admitted attempts to store their outcomes. Reservations, approval gates, and retries resume after a restart; interrupting the wait leaves admission closed. The host sets a deadline and closes its runtime scope afterward ([ADR 0023](../../docs/adr/0023-graceful-attempt-drain.md)).

To handle shutdown during startup, provide `RunEngineShutdown` (`/engine`): a fresh `Deferred<void>` allocated before building the runtime. Completing it closes admission at once, recovered work included. After startup, `drain()` waits for admitted outcomes. The server installs this before building its runtime.

## Composition

All subpaths are platform-free except the Node adapter `@usine/engine/local-sqlite`, whose `layer` provides SQLite, migrations, and startup recovery. Provide a `StepExecutor` at the composition root:

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

`/engine` exports `RunEngine`, `Submission`, submission results, and typed errors; `/run-reader` exports `RunReader` and its snapshot, summary, run event, and evidence types; `/transcript` exports entries, sequences, and queries. Projection contracts are in `/item-projection` and `/repository-label-projection`, and `LoopControl` is in `/loop-control`.

`runReaderLayer(instanceDirectory)` (`/local-sqlite`) provides only `RunReader`, on a read-only connection, for maintenance commands. It needs an existing database and never creates tables, migrates, or changes the journal mode. A missing, unreadable, or incompatible database fails with `EnginePersistenceError`.

`backup(instanceDirectory, destination)` (`/local-sqlite`) copies every runtime table and committed WAL data while other connections stay open. It opens the source read-only, without migrations. The destination must be a new file in an existing directory that supports hard links; the copy is complete, owner-only, and never overwrites a file. `RuntimeStoreBackupError` gives the failed operation (`open`, `stage`, `copy`, or `publish`), both paths, and the underlying message or code. Logs report failures, or the pages copied. If interrupted, the adapter waits for Node's backup to finish before closing and deleting temporary files.

`layerWithDatabase` (`/engine`) takes another SQLite-compatible layer providing `RunDatabase` (`/database`) with atomic transactions, plus the platform `Crypto` layer that hashes dedup keys into run ids. Cloudflare D1 doesn't work with Drizzle RC.4, because its Effect driver can't run the store's transactions.

The Drizzle schema defines usine's tables. After changing it, generate and review a migration:

```sh
pnpm --filter @usine/engine db:generate --name <migration_name>
```

## Shared runtime connection

`localSqliteLayer(directory)` provides `RunDatabase` and the matching `SqlClient`. The `layer` and `observationLayer` functions in `/local-sqlite` accept that database layer as their second argument. Applications can build the connection once and pass its context to the engine and the configuration store; each package maintains its own migration ledger in the runtime file.

## Attention acknowledgements

`AttentionAcknowledgements` from `@usine/engine/attention` records a dismissal by entry ID and content revision, with the configured operator login and time. Repeating the same dismissal preserves the first record. Undo deletes only that revision. The local runtime store persists these records and invalidates operator projections when they change. Run state, failure resolution, and cycle budgets stay unchanged.

`TranscriptWorkerQuery` returns an attempt's latest `WorkerUnresponsive` or `WorkerResponsive` notice. Later session output does not hide the notice, and recovery replaces the outage in this query.

`prune(current)` deletes acknowledgements whose ID and revision don't match any of the supplied current entries. Pass the complete list, including dismissed entries; an empty list clears all acknowledgements. Pruning preserves matching records and invalidates projections only when it deletes rows.

## Project migration

`migrateProjectLoops` from `/database` accepts repository-to-project assignments and migrates stored loop references before the engine starts. The caller runs it in the configuration transaction. It preserves run and event IDs, deduplication, suppression, pause state, cycle budgets, and attention acknowledgements. Repeating the migration leaves qualified identities unchanged. The implementation uses the supplied `SqlClient` and requires no Node adapter.
