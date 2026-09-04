import { Event } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { Context, Crypto, Effect, Layer, Option, Result } from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import { RunDatabase } from "../database/database.ts";
import { AttemptCancellationError, type RunEngineError } from "./error.ts";
import type { RunSnapshot } from "../run-reader/model.ts";
import type { Submission, SubmissionResult } from "./submission.ts";
import type { TranscriptEntry, TranscriptQuery } from "../transcript.ts";
import { RunStore } from "../store/store.ts";
import { RunReader } from "../run-reader/run-reader.ts";
import { ItemProjectionReader, ItemProjectionWriter } from "../item-projection/item-projection.ts";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "../repository-label-projection/repository-label-projection.ts";
import {
  ApprovalGate,
  DurableRun,
  continueWithNewest,
  durableRunLayer,
  runIdFor,
} from "../workflow/workflow.ts";
import { StepExecutor } from "../step-executor.ts";
import { CursorStore } from "../cursor/cursor.ts";
import { LoopControl } from "../loop-control/loop-control.ts";

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

  const deliverInterrupt = Effect.fn("RunEngine.deliverInterrupt")(function* (runId: RunId) {
    yield* DurableRun.interrupt(runId).pipe(provideWorkflowEngine);
    yield* store.completeWorkflowCommand(runId, "Interrupt");
  });

  const deliverApproval = Effect.fn("RunEngine.deliverApproval")(function* (runId: RunId) {
    const token = DurableDeferred.tokenFromExecutionId(ApprovalGate, {
      workflow: DurableRun,
      executionId: runId,
    });
    yield* DurableDeferred.succeed(ApprovalGate, { token, value: undefined }).pipe(
      provideWorkflowEngine,
    );
    yield* store.completeWorkflowCommand(runId, "Approve");
  });

  const deliverContinuation = Effect.fn("RunEngine.deliverContinuation")(function* (runId: RunId) {
    yield* continueWithNewest(store, runId).pipe(provideWorkflowEngine);
  });

  const awaitWorkflowSettlement = Effect.fn("RunEngine.awaitWorkflowSettlement")(function* (
    runId: RunId,
  ) {
    // A Failed projection commits before the workflow finishes suspending, so
    // poll across that handover or an immediate operator retry is lost. A
    // workflow still absent at the deadline means a corrupted instance
    // database, so fail loudly instead of hanging.
    for (let poll = 0; poll < MAX_SETTLEMENT_POLLS; poll += 1) {
      const status = yield* DurableRun.poll(runId).pipe(provideWorkflowEngine);
      if (Option.isSome(status)) return status.value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error(`Run ${runId} has no durable workflow execution to settle`));
  });

  const deliverResume = Effect.fn("RunEngine.deliverResume")(function* (runId: RunId) {
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

  const approve = Effect.fn("RunEngine.approve")(function* (runId: RunId, approval: Event) {
    yield* store.approve(runId, approval);
    yield* deliverApproval(runId);
  });

  const retry = Effect.fn("RunEngine.retry")(function* (runId: RunId) {
    yield* store.retry(runId);
    yield* deliverResume(runId);
  });

  const cancel = Effect.fn("RunEngine.cancel")(function* (runId: RunId) {
    // The closing transaction decides both facts at once: whether the run was
    // still open, and which attempt was in flight when it closed.
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

  const revoke = Effect.fn("RunEngine.revoke")(function* (loop: LoopName, itemKey: ItemKey) {
    const revoked = yield* store.revoke(loop, itemKey);
    yield* Effect.forEach(revoked, deliverInterrupt, {
      concurrency: "unbounded",
      discard: true,
    });
    return revoked;
  });

  const inspect = Effect.fn("RunEngine.inspect")(function* (runId: RunId) {
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
 * The run engine's public service. Widen this interface on purpose, never by
 * letting an implementation change leak through inference.
 */
export class RunEngine extends Context.Service<
  RunEngine,
  {
    readonly approve: (runId: RunId, approval: Event) => Effect.Effect<void, RunEngineError>;
    readonly cancel: (runId: RunId) => Effect.Effect<void, RunEngineError>;
    readonly inspect: (runId: RunId) => Effect.Effect<RunSnapshot, RunEngineError>;
    readonly reconcile: () => Effect.Effect<void, RunEngineError>;
    readonly retry: (runId: RunId) => Effect.Effect<void, RunEngineError>;
    readonly revoke: (
      loop: LoopName,
      itemKey: ItemKey,
    ) => Effect.Effect<ReadonlyArray<RunId>, RunEngineError>;
    readonly submit: (submission: Submission) => Effect.Effect<SubmissionResult, RunEngineError>;
    readonly transcript: (
      query: TranscriptQuery,
    ) => Effect.Effect<ReadonlyArray<TranscriptEntry>, RunEngineError>;
  }
>()("@usine/engine/RunEngine") {}

/**
 * Builds the durable runtime on a caller-selected SQLite-compatible database;
 * the adapter supplies both Drizzle's run database and the matching Effect SQL
 * client. The deployment supplies the platform `Crypto` and the `StepExecutor`,
 * as `database/local-sqlite.ts` does for Node.
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

export {
  Submission,
  Claimed,
  Queued,
  Ignored,
  IgnoreReason,
  SubmissionResult,
} from "./submission.ts";
export {
  RunNotFoundError,
  RunOperationRejectedError,
  EnginePersistenceError,
  AttemptCancellationError,
  RunStoreError,
  RunEngineError,
} from "./error.ts";
