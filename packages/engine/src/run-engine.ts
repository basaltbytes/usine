import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Event, Item, Loop, Run } from "@usine/core";
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster";
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow";
import type { InstanceDirectory, RunEngineError, Submission } from "./model.ts";
import { RunStore } from "./run-store.ts";
import {
  ApprovalGate,
  DurableRun,
  continueWithNewest,
  durableRunLayer,
  runIdFor,
} from "./run-workflow.ts";
import { StepExecutor } from "./step-executor.ts";

const makeRunEngine = Effect.gen(function* () {
  const store = yield* RunStore;
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

  const deliverResume = Effect.fn("RunEngine.deliverResume")(function* (runId: Run.RunId) {
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
    const changed = yield* store.cancel(runId);
    if (changed) {
      yield* deliverInterrupt(runId);
      yield* deliverContinuation(runId);
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
  });

  const inspect = Effect.fn("RunEngine.inspect")(function* (runId: Run.RunId) {
    return yield* store.snapshot(runId);
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

  return { approve, cancel, inspect, reconcile, retry, revoke, submit } as const;
});

export class RunEngine extends Context.Service<RunEngine, Effect.Success<typeof makeRunEngine>>()(
  "@usine/engine/RunEngine",
) {}

const sqliteLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtimeDirectory = path.join(instanceDirectory, ".usine");
      yield* fileSystem.makeDirectory(runtimeDirectory, { recursive: true });
      return SqliteClient.layer({
        filename: path.join(runtimeDirectory, "runtime.sqlite"),
      });
    }).pipe(Effect.orDie, Effect.provide(NodeServices.layer)),
  );

/**
 * Builds the whole single-process durable runtime. The returned layer requires
 * only a `StepExecutor`; SQL, cluster storage, workflow registration, and the
 * startup reconciliation sweep stay behind the engine boundary.
 */
export const layer = (
  instanceDirectory: InstanceDirectory,
): Layer.Layer<RunEngine, RunEngineError, StepExecutor> => {
  const sql = sqliteLayer(instanceDirectory);
  const store = RunStore.layer.pipe(Layer.provide(sql));
  const cluster = SingleRunner.layer({
    runnerStorage: "memory",
    shardingConfig: {
      availableShardGroups: ["default", "workflow"],
      assignedShardGroups: ["default", "workflow"],
      entityTerminationTimeout: 0,
    },
  }).pipe(Layer.provide(sql), Layer.provide(NodeServices.layer), Layer.orDie);
  const workflowEngine = ClusterWorkflowEngine.layer.pipe(Layer.provide(cluster));
  const runtime = durableRunLayer.pipe(
    Layer.provideMerge(workflowEngine),
    Layer.provideMerge(store),
  );
  return Layer.effect(RunEngine, makeRunEngine).pipe(Layer.provide(runtime));
};
