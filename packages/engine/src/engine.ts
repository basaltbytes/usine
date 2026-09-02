import { Event, Item, Loop, Run } from "@usine/core";
import { Context, Crypto, Effect, Layer, Option, Result } from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { RunDatabase } from "./database/database.ts";
import {
  AttemptCancellationError,
  type RunEngineError,
  type RunSnapshot,
  type Submission,
  type SubmissionResult,
  type TranscriptEntry,
  type TranscriptQuery,
} from "./model.ts";
import { RunStore } from "./store/store.ts";
import { RunReader } from "./run-reader.ts";
import { ItemProjectionReader, ItemProjectionWriter } from "./item-projection/service.ts";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "./repository-label-projection/service.ts";
import {
  ApprovalGate,
  DurableRun,
  continueWithNewest,
  durableRunLayer,
  runIdFor,
} from "./workflow.ts";
import { StepExecutor } from "./step-executor.ts";
import { CursorStore } from "./cursor/store.ts";
import { LoopControl } from "./loop-control.ts";

const MAX_SETTLEMENT_POLLS = 500;

const makeRunEngine = Effect.gen(function* () {
  const store = yield* RunStore;
  const stepExecutor = yield* StepExecutor;
  const workflowEngine = yield* WorkflowEngine.WorkflowEngine;
  const provideWorkflowEngine = <A, E>(
    effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>,
  ): Effect.Effect<A, E> =>
    Effect.provideService(effect, WorkflowEngine.WorkflowEngine, workflowEngine);

  const launch = Effect.fn("RunEngine.launch")(function* (submission: Submission) {
    yield* DurableRun.execute({ submission }, { discard: true }).pipe(provideWorkflowEngine);
  });

  const deliverInterrupt = Effect.fn("RunEngine.deliverInterrupt")(function* (runId: Run.RunId) {
    yield* DurableRun.interrupt(runId).pipe(provideWorkflowEngine);
    yield* store.completeWorkflowCommand(runId, "Interrupt");
  });

  const deliverApproval = Effect.fn("RunEngine.deliverApproval")(function* (runId: Run.RunId) {
    const token = DurableDeferred.tokenFromExecutionId(ApprovalGate, {
      workflow: DurableRun,
      executionId: runId,
    });
    yield* DurableDeferred.succeed(ApprovalGate, { token, value: undefined }).pipe(
      provideWorkflowEngine,
    );
    yield* store.completeWorkflowCommand(runId, "Approve");
  });

  const deliverContinuation = Effect.fn("RunEngine.deliverContinuation")(function* (
    runId: Run.RunId,
  ) {
    yield* continueWithNewest(store, runId).pipe(provideWorkflowEngine);
  });

  const awaitWorkflowSettlement = Effect.fn("RunEngine.awaitWorkflowSettlement")(function* (
    runId: Run.RunId,
  ) {
    // A Failed projection is committed before the workflow finishes suspending.
    // Poll across that short handover so an immediate operator retry is not
    // lost. A workflow still absent at the deadline is a corrupted instance
    // database, not a race — die loudly instead of hanging delivery forever.
    for (let poll = 0; poll < MAX_SETTLEMENT_POLLS; poll += 1) {
      const status = yield* DurableRun.poll(runId).pipe(provideWorkflowEngine);
      if (Option.isSome(status)) return status.value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error(`Run ${runId} has no durable workflow execution to settle`));
  });

  const deliverResume = Effect.fn("RunEngine.deliverResume")(function* (runId: Run.RunId) {
    const status = yield* awaitWorkflowSettlement(runId);
    if (status._tag === "Complete") {
      yield* store.reconcileCompletion(runId, status);
      yield* store.completeWorkflowCommand(runId, "Resume");
      yield* deliverContinuation(runId);
      return;
    }
    yield* DurableRun.resume(runId).pipe(provideWorkflowEngine);
    yield* store.completeWorkflowCommand(runId, "Resume");
  });

  const commandHandlers = {
    Approve: deliverApproval,
    Continue: deliverContinuation,
    Interrupt: deliverInterrupt,
    Resume: deliverResume,
  } as const;

  const submit = Effect.fn("RunEngine.submit")(function* (submission: Submission) {
    const requestedRunId = yield* runIdFor(submission);
    const claim = yield* store.recordAndClaim(submission, requestedRunId);
    if (Option.isSome(claim.supersededRun)) {
      yield* deliverInterrupt(claim.supersededRun.value);
    }
    if (claim.result._tag === "Claimed") {
      yield* launch(claim.submission);
    }
    return claim.result;
  });

  const approve = Effect.fn("RunEngine.approve")(function* (
    runId: Run.RunId,
    approval: Event.Event,
  ) {
    yield* store.approve(runId, approval);
    yield* deliverApproval(runId);
  });

  const retry = Effect.fn("RunEngine.retry")(function* (runId: Run.RunId) {
    yield* store.retry(runId);
    yield* deliverResume(runId);
  });

  const cancel = Effect.fn("RunEngine.cancel")(function* (runId: Run.RunId) {
    // The closing transaction decides both facts at once: whether the run was
    // still open, and which attempt (if any) was in flight when it closed.
    const outcome = yield* store.cancel(runId);
    if (outcome._tag === "AlreadyClosed") {
      yield* Effect.logDebug("Cancel was a no-op; the run was already closed", { runId });
      return;
    }
    yield* Effect.logInfo("Run canceled", {
      runId,
      openAttempt: Option.getOrElse(outcome.openAttempt, () => "none"),
    });
    const handshake = Option.isSome(outcome.openAttempt)
      ? yield* stepExecutor.interrupt(outcome.openAttempt.value).pipe(Effect.result)
      : Result.succeed(undefined);
    yield* deliverInterrupt(runId);
    yield* deliverContinuation(runId);
    if (Option.isSome(outcome.openAttempt) && Result.isFailure(handshake)) {
      return yield* new AttemptCancellationError({
        attemptId: outcome.openAttempt.value,
        cause: handshake.failure,
      });
    }
  });

  const revoke = Effect.fn("RunEngine.revoke")(function* (
    loop: Loop.LoopName,
    itemKey: Item.ItemKey,
  ) {
    const revoked = yield* store.revoke(loop, itemKey);
    yield* Effect.forEach(revoked, deliverInterrupt, {
      concurrency: "unbounded",
      discard: true,
    });
    return revoked;
  });

  const inspect = Effect.fn("RunEngine.inspect")(function* (runId: Run.RunId) {
    return yield* store.snapshot(runId);
  });

  const transcript = Effect.fn("RunEngine.transcript")(function* (query: TranscriptQuery) {
    return yield* store.transcript(query);
  });

  const reconcile = Effect.fn("RunEngine.reconcile")(function* () {
    yield* Effect.forEach(
      yield* store.pendingWorkflowCommands,
      ({ command, runId }) => commandHandlers[command](runId),
      { discard: true },
    );
    const recoverable = yield* store.recoverable;
    yield* Effect.forEach(
      recoverable,
      ({ runId, state, submission }) =>
        Effect.gen(function* () {
          const status = yield* DurableRun.poll(runId).pipe(provideWorkflowEngine);
          if (Option.isSome(status) && status.value._tag === "Complete") {
            yield* store.reconcileCompletion(runId, status.value);
            yield* deliverContinuation(runId);
            return;
          }
          if (Option.isSome(status) && status.value._tag === "Suspended") {
            if (state._tag === "Running") {
              yield* deliverResume(runId);
            }
            return;
          }
          yield* launch(submission);
        }),
      { concurrency: "unbounded", discard: true },
    );
  });

  yield* reconcile();

  return { approve, cancel, inspect, reconcile, retry, revoke, submit, transcript } as const;
});

/**
 * The public run-engine service. The interface below is the package's declared
 * API — widen it deliberately, never by letting an implementation change leak
 * through inference.
 */
export class RunEngine extends Context.Service<
  RunEngine,
  {
    readonly approve: (
      runId: Run.RunId,
      approval: Event.Event,
    ) => Effect.Effect<void, RunEngineError>;
    readonly cancel: (runId: Run.RunId) => Effect.Effect<void, RunEngineError>;
    readonly inspect: (runId: Run.RunId) => Effect.Effect<RunSnapshot, RunEngineError>;
    readonly reconcile: () => Effect.Effect<void, RunEngineError>;
    readonly retry: (runId: Run.RunId) => Effect.Effect<void, RunEngineError>;
    readonly revoke: (
      loop: Loop.LoopName,
      itemKey: Item.ItemKey,
    ) => Effect.Effect<ReadonlyArray<Run.RunId>, RunEngineError>;
    readonly submit: (submission: Submission) => Effect.Effect<SubmissionResult, RunEngineError>;
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunEngineError>;
  }
>()("@usine/engine/RunEngine") {}

/**
 * Builds the durable runtime on a caller-selected SQLite-compatible database.
 * The adapter must provide both Drizzle's run database and the matching Effect
 * SQL client so run projections and cluster tables stay co-located. This entry
 * is platform-free: the deployment supplies its platform `Crypto` (the cluster
 * hashes over-length deduplication keys with it) next to the `StepExecutor`
 * port — see `database/local-sqlite.ts` for the Node composition.
 */
export const layerWithDatabase = <DatabaseError, DatabaseRequirements>(
  database: Layer.Layer<RunDatabase | SqlClient.SqlClient, DatabaseError, DatabaseRequirements>,
): Layer.Layer<
  | CursorStore
  | ItemProjectionReader
  | ItemProjectionWriter
  | LoopControl
  | RepositoryLabelProjectionReader
  | RepositoryLabelProjectionWriter
  | RunEngine
  | RunReader,
  RunEngineError | DatabaseError,
  Crypto.Crypto | StepExecutor | DatabaseRequirements
> => {
  const store = RunStore.layer.pipe(Layer.provide(database));
  const cluster = SingleRunner.layer({
    runnerStorage: "memory",
    shardingConfig: {
      availableShardGroups: ["default", "workflow"],
      assignedShardGroups: ["default", "workflow"],
      entityTerminationTimeout: 0,
    },
  }).pipe(Layer.provide(database), Layer.orDie);
  const workflowEngine = ClusterWorkflowEngine.layer.pipe(Layer.provide(cluster));
  const runtime = durableRunLayer.pipe(
    Layer.provideMerge(workflowEngine),
    Layer.provideMerge(store),
  );
  const runEngine = Layer.effect(RunEngine, makeRunEngine).pipe(Layer.provide(runtime));
  return Layer.mergeAll(
    runEngine,
    RunReader.layer.pipe(Layer.provide(database)),
    CursorStore.layer.pipe(Layer.provide(database)),
    ItemProjectionReader.layer.pipe(Layer.provide(database)),
    ItemProjectionWriter.layer.pipe(Layer.provide(database)),
    RepositoryLabelProjectionReader.layer.pipe(Layer.provide(database)),
    RepositoryLabelProjectionWriter.layer.pipe(Layer.provide(database)),
    LoopControl.layer.pipe(Layer.provide(database)),
  );
};
