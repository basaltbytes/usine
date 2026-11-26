import { ChangeBus } from "@usine/core/changes";
import { Attempt, AttemptId } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { type WorkerKind, WorkerName } from "@usine/core/worker";
import { StepResult } from "@usine/core/step/result";
import { type Brand, DateTime, Effect, Match, Option, Schema } from "effect";
import { RunDatabase } from "../database/database.ts";
import {
  beginAttempt as decideBeginAttempt,
  finishAttempt as decideFinishAttempt,
  operatorStop,
  type OperatorStop,
  type FinishDecision,
  type AttemptResult,
} from "../engine/lifecycle.ts";
import { RunSnapshot } from "../run-reader/model.ts";
import { StepExecution } from "../step-executor.ts";
import { persistence } from "./codec.ts";
import { type RunQueries, runTransaction } from "./queries/queries.ts";
import { TranscriptCodec } from "./transcript/codec.ts";

export class AttemptStarted extends Schema.TaggedClass<
  AttemptStarted,
  Brand.Brand<"@usine/engine/store/store/AttemptStarted">
>("@usine/engine/internal/AttemptStarted")("AttemptStarted", {
  execution: StepExecution,
}) {}

/** A Run that failed because failing the interrupted Attempt used its last automatic retry. */
export class AttemptRecoveryFailed extends Schema.TaggedClass<
  AttemptRecoveryFailed,
  Brand.Brand<"@usine/engine/store/store/AttemptRecoveryFailed">
>("@usine/engine/internal/AttemptRecoveryFailed")("AttemptRecoveryFailed", {}) {}

/** A Run that closed (canceled, superseded, or revoked) while waiting for a Worker slot; not an error. */
export class RunClosed extends Schema.TaggedClass<
  RunClosed,
  Brand.Brand<"@usine/engine/store/store/RunClosed">
>("@usine/engine/internal/RunClosed")("RunClosed", {}) {}

/** Returns the `RunStore` operations that start and finish Attempts and park Runs for approval. */
export const attemptOperations = Effect.gen(function* () {
  const database = yield* RunDatabase;
  const bus = yield* ChangeBus;
  const codec = yield* TranscriptCodec;
  const inTransaction = runTransaction(database, bus, codec);

  const parkForApproval = Effect.fn("RunStore.parkForApproval")(function* (runId: RunId) {
    yield* Effect.annotateCurrentSpan({ runId });
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        const current = yield* tx.snapshot(runId);
        if (current.run.state._tag !== "Pending") return current.run.state;
        const waiting = RunState.awaitApproval(current.run.state);
        yield* tx.updateState(runId, waiting);
        return waiting;
      }),
    );
  }, persistence("park run for approval"));

  // Runs in the caller's transaction, so Attempt, Run, Step, and outbox writes commit or roll
  // back together.
  const applyFinish = Effect.fn("RunStore.applyFinish")(function* (
    tx: RunQueries,
    runId: RunId,
    decision: FinishDecision,
  ) {
    yield* Effect.annotateCurrentSpan({ runId });
    if (decision._tag === "Unchanged") {
      yield* Effect.logInfo("Attempt completion ignored", { runId, reason: decision.reason });
      return;
    }
    const { attempt, outcome } = decision;
    yield* Effect.annotateCurrentSpan({ attemptId: attempt.id });
    const fields = {
      runId,
      attemptId: attempt.id,
      number: attempt.number,
      decision: decision._tag,
    };
    yield* Effect.logInfo(
      "Attempt completion decided",
      Match.valueTags(outcome, {
        Failed: ({ failure }) => ({ ...fields, failure: failure._tag }),
        Succeeded: () => fields,
        AwaitingCi: () => fields,
      }),
    );
    const endedAt = yield* DateTime.now;
    yield* tx.closeAttempt(attempt.id, outcome, endedAt);
    if (decision._tag === "RunSucceeded" || decision._tag === "RunAwaitingCi") {
      const result = StepResult.make({ ...decision.result, attemptId: Option.some(attempt.id) });
      yield* tx.recordAttemptResult(attempt.id, result);
      yield* tx.updateStepResult(runId, attempt.stepName, result);
    } else if (Option.isSome(decision.harvested)) {
      yield* tx.recordAttemptResult(
        attempt.id,
        StepResult.make({ ...decision.harvested.value, attemptId: Option.some(attempt.id) }),
      );
    }
    if (decision._tag === "RetryAttempt") return;
    yield* tx.updateState(runId, decision.state, endedAt);
  });

  // The Event queued during the Attempt is usually the Agent's own question or blocker comment,
  // so it becomes the suppressed state.
  const suppressForOperator = Effect.fn("RunStore.suppressForOperator")(function* (
    tx: RunQueries,
    current: RunSnapshot,
    stop: OperatorStop,
  ) {
    const runId = current.run.id;
    const queuedRun = yield* tx.nextQueued(runId);
    const queued = Option.map(queuedRun, ({ submission }) => submission.event.id);
    const fields = { runId, loop: current.run.loop, itemKey: current.itemKey, stop };
    if (
      yield* tx.loopItems.startSuppression(
        current.run.loop,
        current.itemKey,
        runId,
        current.event.id,
        queued,
      )
    ) {
      yield* Effect.logInfo("Agent stopped for the operator; its Loop suppresses the Item", {
        ...fields,
        suppressedEventId: Option.getOrElse(queued, () => "none yet"),
      });
      return;
    }
    yield* Effect.logInfo(
      "Agent stopped for the operator, but nothing is suppressed; the Loop last saw the Item not matching",
      fields,
    );
  });

  const executionOf = (
    current: RunSnapshot,
    {
      attempt,
      state,
      resume,
      reattach,
    }: Pick<StepExecution, "attempt" | "resume" | "reattach"> & {
      readonly state: RunState.Running;
    },
  ) =>
    StepExecution.make({
      attempt,
      event: current.event,
      run: Run.make({
        id: current.run.id,
        eventId: current.run.eventId,
        loop: current.run.loop,
        state,
        openedAt: current.run.openedAt,
      }),
      step: current.step,
      repository: current.repository,
      revision: current.revision,
      task: current.task,
      agent: current.agent,
      permissions: current.permissions,
      resume,
      reattach,
      requiresCi: Option.isSome(current.ciPolicy),
      outcomeLabels: current.outcomeLabels,
    });

  const beginAttempt = Effect.fn("RunStore.beginAttempt")(function* (
    runId: RunId,
    worker: WorkerName,
    kind: WorkerKind,
    live: Option.Option<AttemptId>,
  ) {
    yield* Effect.annotateCurrentSpan({ runId, worker, workerKind: kind });
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        const current = yield* tx.snapshot(runId);
        const interruption = InfraFailure.make({
          message: "The orchestrator stopped during the attempt",
          cause: new Error("attempt interrupted by orchestrator restart"),
        });
        const requested = yield* tx.nextStart(runId);
        const decision = decideBeginAttempt(current, interruption, live, requested);
        if (decision._tag === "RunClosed") {
          yield* Effect.logInfo("Attempt start skipped", { runId, state: decision.state._tag });
          return RunClosed.make();
        }
        if (decision._tag === "RunFailed") {
          yield* applyFinish(tx, runId, decision);
          return AttemptRecoveryFailed.make();
        }
        if (decision._tag === "ReattachAttempt") {
          const reattachedAt = yield* DateTime.now;
          const attempt = Attempt.make({
            ...decision.attempt,
            reattachedAt: Option.some(reattachedAt),
          });
          yield* tx.recordReattach(attempt.id, reattachedAt);
          yield* Effect.annotateCurrentSpan({ attemptId: attempt.id });
          yield* Effect.logInfo("Attempt reattached after an orchestrator restart", {
            runId,
            attemptId: attempt.id,
            number: attempt.number,
            worker: attempt.worker,
          });
          if (attempt.worker !== worker) {
            // The Run reserves a slot on the Attempt's own Worker (#177), so a lease on another
            // Worker is a `StepExecutor` defect.
            yield* Effect.logError(
              "Reattached Attempt keeps its own Worker, not the reserved one",
              {
                runId,
                attemptId: attempt.id,
                worker: attempt.worker,
                reservedWorker: worker,
              },
            );
          }
          return AttemptStarted.make({
            execution: executionOf(current, {
              attempt,
              state: decision.state,
              resume: decision.resume,
              reattach: true,
            }),
          });
        }
        if (Option.isSome(decision.interrupted)) {
          yield* applyFinish(tx, runId, decision.interrupted.value);
        }
        if (current.run.state._tag !== decision.state._tag) {
          yield* tx.updateState(runId, decision.state);
        }
        const attemptId = AttemptId.make(`${runId}/${current.step.name}/${decision.number}`);
        const startedAt = yield* DateTime.now;
        const attempt = Attempt.make({
          id: attemptId,
          runId,
          stepName: current.step.name,
          worker,
          workerKind: Option.some(kind),
          number: decision.number,
          brain: current.agent.brain,
          task: current.task,
          agent: current.agent.name,
          operatorIntervened: false,
          parentModel: Option.none(),
          startedAt,
          outcome: Option.none(),
          endedAt: Option.none(),
          salvage: Option.none(),
          start: Option.some(decision.start),
          reattachedAt: Option.none(),
        });
        yield* tx.addAttempt(attempt);
        if (Option.isSome(requested)) yield* tx.setNextStart(runId, Option.none());
        yield* Effect.logInfo("Attempt started", {
          runId,
          attemptId,
          number: decision.number,
          worker,
          workerKind: kind,
          start: decision.start._tag,
          resumesFrom: Option.map(decision.resume, ({ ref }) => ref),
        });
        return AttemptStarted.make({
          execution: executionOf(current, {
            attempt,
            state: decision.state,
            resume: decision.resume,
            reattach: false,
          }),
        });
      }),
    );
  }, persistence("begin attempt"));

  const finishAttempt = Effect.fn("RunStore.finishAttempt")(function* (
    attempt: Attempt,
    result: AttemptResult,
  ) {
    yield* Effect.annotateCurrentSpan({ runId: attempt.runId, attemptId: attempt.id });
    return yield* inTransaction((tx) =>
      Effect.gen(function* () {
        const current = yield* tx.snapshot(attempt.runId);
        const [route] = yield* tx.eventRouteByRun(attempt.runId);
        if (route === undefined) return yield* Effect.die("A run has no recorded event");
        const decision = decideFinishAttempt(
          current,
          attempt.id,
          result,
          current.ciPolicy,
          route.ciOnGreen,
        );
        yield* applyFinish(tx, attempt.runId, decision);
        const stop = operatorStop(decision, result);
        if (Option.isSome(stop)) yield* suppressForOperator(tx, current, stop.value);
        return decision;
      }),
    );
  }, persistence("finish attempt"));

  return { beginAttempt, finishAttempt, parkForApproval } as const;
});
