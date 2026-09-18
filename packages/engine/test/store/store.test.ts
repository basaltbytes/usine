import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";

import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  SessionStarted,
  HarnessSession,
  HarnessSessionId,
  SessionIdle,
  TextOutput,
} from "@usine/core/agent/session";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import { SalvagePushed, SalvageRef, SalvageRetained } from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";

import { DateTime, Effect, Exit, FileSystem, Layer, Option, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Workflow } from "effect/unstable/workflow";

import { localSqliteLayer } from "../../src/database/local-sqlite.ts";

import { CursorKey, CursorStore } from "../../src/cursor/cursor.ts";
import { LoopControl } from "../../src/loop-control/loop-control.ts";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionSource,
} from "../../src/item-projection/model.ts";
import {
  ItemProjectionReader,
  ItemProjectionWriter,
} from "../../src/item-projection/item-projection.ts";
import {
  RepositoryLabel,
  RepositoryLabelProjection,
} from "../../src/repository-label-projection/model.ts";
import {
  RepositoryLabelProjectionReader,
  RepositoryLabelProjectionWriter,
} from "../../src/repository-label-projection/repository-label-projection.ts";
import { Submission } from "../../src/engine/submission.ts";
import { TranscriptSessionsQuery, TranscriptPageQuery } from "../../src/transcript.ts";
import { InstanceDirectory } from "@usine/core/instance";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { RunStore } from "../../src/store/store.ts";

import { testAgent, lifecycleSubmission, withRunStore } from "./support.ts";
describe("run store", () => {
  it.live(
    "persists failure resolution across restart without changing history and rejects stale Attempts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fs.makeTempDirectoryScoped({ prefix: "usine-resolved-failure-" }),
        );
        const runId = RunId.make("resolved-failure");
        const services = Layer.mergeAll(RunStore.layer, RunReader.layer).pipe(
          Layer.provide(localSqliteLayer(directory)),
        );
        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* RunStore;
            const reader = yield* RunReader;
            yield* store.recordAndClaim(lifecycleSubmission, runId);
            const rejected = yield* Effect.flip(
              store.resolveFailure(runId, AttemptId.make("not-started")),
            );
            assert.strictEqual(rejected._tag, "RunOperationRejectedError");
            const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
            assert(started._tag === "AttemptStarted");
            const attempt = started.execution.attempt;
            assert.strictEqual(
              (yield* Effect.flip(store.resolveFailure(runId, attempt.id)))._tag,
              "RunOperationRejectedError",
            );
            yield* store.appendTranscript(
              "outbound",
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId: attempt.id,
                sequence: AttemptChannel.Sequence.make(1),
                sentAt: attempt.startedAt,
                payload: new AttemptChannel.Failed({
                  failure: new AgentFailure({ message: "Handled outside usine" }),
                }),
              }),
            );
            yield* store.finishAttempt(
              attempt,
              Result.fail(new AgentFailure({ message: "Handled outside usine" })),
            );
            const evidence = yield* reader.evidence(runId);
            const commands = yield* store.pendingWorkflowCommands;
            const revision = yield* reader.revision();
            yield* store.resolveFailure(runId, attempt.id);
            const resolvedRevision = yield* reader.revision();
            assert(Option.isSome(revision) && Option.isSome(resolvedRevision));
            assert(resolvedRevision.value > revision.value);
            yield* store.resolveFailure(runId, attempt.id);
            assert.deepStrictEqual(yield* reader.revision(), resolvedRevision);
            assert.deepStrictEqual(yield* store.pendingWorkflowCommands, commands);
            return evidence;
          }).pipe(Effect.provide(services)),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* RunStore;
            const reader = yield* RunReader;
            const after = yield* reader.evidence(runId);
            const first = before.snapshot.attempts[0];
            assert(first !== undefined);
            assert.deepStrictEqual(after.snapshot.run, before.snapshot.run);
            assert.deepStrictEqual(after.snapshot.attempts, before.snapshot.attempts);
            assert.deepStrictEqual(after.transcript, before.transcript);
            assert.deepStrictEqual(after.snapshot.resolvedFailureAttemptId, Option.some(first.id));
            const summaries = yield* reader.list({ closedLimit: 10 });
            assert.deepStrictEqual(summaries[0]?.resolvedFailureAttemptId, Option.some(first.id));
            const history = yield* reader.forItems([lifecycleSubmission.itemKey]);
            assert.deepStrictEqual(history[0]?.resolvedFailureAttemptId, Option.some(first.id));
            yield* store.retry(runId);
            const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
            assert(started._tag === "AttemptStarted");
            yield* store.finishAttempt(
              started.execution.attempt,
              Result.fail(new AgentFailure({ message: "New failure" })),
            );
            const stale = yield* Effect.flip(store.resolveFailure(runId, first.id));
            assert.strictEqual(stale._tag, "RunOperationRejectedError");
            const current = yield* store.snapshot(runId);
            assert.strictEqual(current.run.state._tag, "Failed");
            assert.strictEqual(current.attempts.length, 2);
            assert.deepStrictEqual(current.resolvedFailureAttemptId, Option.some(first.id));
            yield* store.resolveFailure(runId, started.execution.attempt.id);
            assert.deepStrictEqual(
              (yield* store.snapshot(runId)).resolvedFailureAttemptId,
              Option.some(started.execution.attempt.id),
            );
          }).pipe(Effect.provide(services)),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "attributes interventions without adding Events and reads held sessions beyond the visible page",
    () =>
      withRunStore(
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("intervened");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
          assert(started._tag === "AttemptStarted");
          const attemptId = started.execution.attempt.id;
          const parent = new ParentSession({
            id: AgentSessionId.make("parent"),
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          const child = new ChildSession({
            id: AgentSessionId.make("held-child"),
            parentId: parent.id,
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          let sequence = 0;
          const emit = (payload: AttemptChannel.OutboundPayload) =>
            store.appendTranscript(
              "outbound",
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(++sequence),
                sentAt: DateTime.makeUnsafe("2026-09-12"),
                payload,
              }),
            );
          yield* emit(
            new AttemptChannel.SessionEvent({ event: new SessionStarted({ session: parent }) }),
          );
          yield* emit(
            new AttemptChannel.SessionEvent({
              event: new SessionStarted({
                session: child,
                harnessSession: Option.some(
                  new HarnessSession({
                    id: HarnessSessionId.make("vendor-1"),
                    cwd: "/worker/repo",
                  }),
                ),
              }),
            }),
          );
          const intervention = new AttemptChannel.Intervention({
            operator: "Philippe",
            target: new AttemptChannel.ChildTarget({ sessionId: child.id }),
            action: new AttemptChannel.OperatorMessage({ message: "Review with me" }),
          });
          yield* emit(
            new AttemptChannel.InterventionRejected({
              inputSequence: AttemptChannel.Sequence.make(1),
              intervention,
              message: "Temporarily unavailable",
            }),
          );
          assert.strictEqual((yield* store.snapshot(runId)).attempts[0]?.operatorIntervened, false);
          yield* emit(
            new AttemptChannel.InterventionApplied({
              inputSequence: AttemptChannel.Sequence.make(2),
              intervention,
              state: new AttemptChannel.InterventionState({ held: true, paused: false }),
            }),
          );
          yield* emit(
            new AttemptChannel.SessionEvent({ event: new SessionIdle({ session: child }) }),
          );
          for (let index = 0; index < 5; index++)
            yield* emit(
              new AttemptChannel.SessionEvent({
                event: new TextOutput({ session: parent, text: `Parent progress ${index}` }),
              }),
            );
          const state = yield* store.transcript(new TranscriptSessionsQuery({ attemptId }));
          assert.deepStrictEqual(
            state.map(({ envelope }) =>
              envelope.payload._tag === "SessionEvent"
                ? envelope.payload.event._tag
                : envelope.payload._tag,
            ),
            ["SessionStarted", "SessionStarted", "InterventionApplied", "SessionIdle"],
          );
          const launch = state[1]?.envelope.payload;
          assert(launch?._tag === "SessionEvent" && launch.event._tag === "SessionStarted");
          assert(Option.isSome(launch.event.harnessSession));
          assert.strictEqual(launch.event.harnessSession.value.id, "vendor-1");
          assert.strictEqual(launch.event.harnessSession.value.cwd, "/worker/repo");
          const held = state[2]?.envelope.payload;
          assert(held?._tag === "InterventionApplied");
          assert.strictEqual(held.intervention.operator, "Philippe");
          const page = yield* store.transcript(
            new TranscriptPageQuery({ attemptId, before: Option.none(), limit: 2 }),
          );
          assert(
            page.every(
              ({ envelope }) =>
                envelope.payload._tag === "SessionEvent" &&
                envelope.payload.event._tag === "TextOutput",
            ),
          );
          assert.strictEqual((yield* store.snapshot(runId)).attempts[0]?.operatorIntervened, true);
          const sql = yield* SqlClient.SqlClient;
          assert.strictEqual((yield* sql`SELECT count(*) as count FROM usine_events`)[0]?.count, 1);
        }),
      ),
  );

  it.live("ignores a late completion from an Attempt replaced during recovery", () =>
    withRunStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const runId = RunId.make("late-completion");
        yield* store.recordAndClaim(lifecycleSubmission, runId);
        const first = yield* store.beginAttempt(runId, WorkerName.make("local"));
        const recovered = yield* store.beginAttempt(runId, WorkerName.make("local"));
        assert(first._tag === "AttemptStarted" && recovered._tag === "AttemptStarted");
        yield* store.finishAttempt(
          first.execution.attempt,
          Result.fail(new AgentFailure({ message: "late failure" })),
        );
        assert.strictEqual((yield* store.snapshot(runId)).run.state._tag, "Running");
        yield* store.finishAttempt(
          first.execution.attempt,
          Result.succeed(new StepResult({ message: "late", facts: [] })),
        );
        const current = yield* store.snapshot(runId);
        assert.strictEqual(current.run.state._tag, "Running");
        assert(Option.isNone(current.step.result));
        const active = current.attempts[1];
        assert(active !== undefined && Option.isNone(active.outcome));
        assert.deepStrictEqual(yield* store.pendingWorkflowCommands, []);
        yield* store.finishAttempt(
          recovered.execution.attempt,
          Result.succeed(new StepResult({ message: "current", facts: [] })),
        );
        const finished = yield* store.snapshot(runId);
        yield* store.finishAttempt(
          recovered.execution.attempt,
          Result.succeed(new StepResult({ message: "duplicate", facts: [] })),
        );
        assert.deepStrictEqual(yield* store.snapshot(runId), finished);
        assert.strictEqual(finished.run.state._tag, "Succeeded");
      }),
    ),
  );

  it.live("commits the failed state with the capped Attempt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-" }),
      );
      const event = new Event({
        id: EventId.make("store-event"),
        dedupKey: DedupKey.make("store/event/revision"),
        payload: {},
        receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
      });
      const submission = new Submission({
        event,
        itemKey: ItemKey.make("store-item"),
        loop: LoopName.make("store-loop"),
        step: StepName.make("store-step"),
        approval: "none",
        repository: RepositoryName.make("basaltbytes/usine"),
        revision: RepositoryRevision.make("store-revision"),
        task: AttemptTask.make("Run the store test"),
        agent: testAgent,
        parentModel: Option.none(),
      });
      const runId = RunId.make("store-run");
      const failure = new InfraFailure({
        message: "offline",
        cause: new Error("offline"),
      });

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        for (let number = 1; number <= 3; number += 1) {
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
          assert.strictEqual(started._tag, "AttemptStarted");
          if (started._tag !== "AttemptStarted") return;
          assert.deepStrictEqual(started.execution.attempt.brain, testAgent.brain);
          assert.deepStrictEqual(started.execution.attempt.parentModel, Option.none());
          assert.strictEqual(
            (yield* store.finishAttempt(started.execution.attempt, Result.fail(failure)))._tag,
            number < 3 ? "RetryAttempt" : "RunFailed",
          );
          assert.deepStrictEqual(
            (yield* store.pendingWorkflowCommands).map(({ command }) => command),
            number < 3 ? [] : ["Continue"],
          );
        }
        const snapshot = yield* store.snapshot(runId);
        assert.strictEqual(snapshot.itemKey, submission.itemKey);
        assert.strictEqual(snapshot.run.state._tag, "Failed");
        assert.strictEqual(snapshot.attempts.length, 3);
        assert(snapshot.attempts.every((attempt) => Option.isSome(attempt.outcome)));
        assert(Option.isNone(snapshot.step.result));

        yield* store.retry(runId);
        yield* store.retry(runId);
        assert.deepStrictEqual(
          (yield* store.pendingWorkflowCommands).map(({ command }) => command),
          ["Resume", "Continue"],
        );
        yield* store.completeWorkflowCommand(runId, "Resume");
        assert.strictEqual(
          (yield* Effect.flip(store.retry(runId)))._tag,
          "RunOperationRejectedError",
        );
        const restarted = yield* store.beginAttempt(runId, WorkerName.make("local"));
        assert(restarted._tag === "AttemptStarted");
        assert.strictEqual(restarted.execution.attempt.number, 4);
        assert.strictEqual(
          (yield* store.finishAttempt(restarted.execution.attempt, Result.fail(failure)))._tag,
          "RunFailed",
        );
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "caps interrupted Attempts and cancels an operator retry before another Attempt starts",
    () =>
      withRunStore(
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("interrupted-cap");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          for (let number = 1; number <= 3; number += 1) {
            const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
            assert(started._tag === "AttemptStarted");
            assert.strictEqual(started.execution.attempt.number, number);
          }
          const exhausted = yield* store.beginAttempt(runId, WorkerName.make("local"));
          assert.strictEqual(exhausted._tag, "AttemptRecoveryFailed");
          const failed = yield* store.snapshot(runId);
          assert.strictEqual(failed.run.state._tag, "Failed");
          assert.strictEqual(failed.attempts.length, 3);
          for (const attempt of failed.attempts) {
            assert(Option.isSome(attempt.outcome) && attempt.outcome.value._tag === "Failed");
            assert.strictEqual(attempt.outcome.value.failure._tag, "InfraFailure");
          }
          assert.deepStrictEqual(
            (yield* store.pendingWorkflowCommands).map(({ command }) => command),
            ["Continue"],
          );
          yield* store.retry(runId);
          const canceled = yield* store.cancel(runId);
          assert(canceled._tag === "Canceled" && Option.isNone(canceled.openAttempt));
          assert.strictEqual(
            (yield* store.beginAttempt(runId, WorkerName.make("local")))._tag,
            "RunClosed",
          );
          assert.deepStrictEqual((yield* store.snapshot(runId)).attempts, failed.attempts);
          assert.deepStrictEqual(
            (yield* store.pendingWorkflowCommands).map(({ command }) => command),
            ["Interrupt", "Continue"],
          );
        }),
      ),
  );

  for (const exit of [
    Exit.succeed(new StepResult({ message: "durable result", facts: [] })),
    Exit.fail(new InfraFailure({ message: "durable failure", cause: new Error("offline") })),
  ]) {
    it.live(
      `reconciles final workflow ${exit._tag} without retrying or replacing a settled outcome`,
      () =>
        withRunStore(
          Effect.gen(function* () {
            const store = yield* RunStore;
            const runId = RunId.make("final-reconciliation");
            yield* store.recordAndClaim(lifecycleSubmission, runId);
            yield* store.beginAttempt(runId, WorkerName.make("local"));
            const complete = new Workflow.Complete({ exit });
            yield* store.reconcileCompletion(runId, complete);
            const settled = yield* store.snapshot(runId);
            assert.strictEqual(
              settled.run.state._tag,
              Exit.isSuccess(exit) ? "Succeeded" : "Failed",
            );
            assert.strictEqual(settled.attempts.length, 1);
            const attempt = settled.attempts[0];
            assert(attempt !== undefined && Option.isSome(attempt.outcome));
            assert.strictEqual(
              attempt.outcome.value._tag,
              Exit.isSuccess(exit) ? "Succeeded" : "Failed",
            );
            assert.deepStrictEqual(
              settled.step.result,
              Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none(),
            );
            assert.deepStrictEqual(
              (yield* store.pendingWorkflowCommands).map(({ command }) => command),
              ["Continue"],
            );
            yield* store.reconcileCompletion(runId, complete);
            yield* store.reconcileCompletion(
              runId,
              new Workflow.Complete({
                exit: Exit.succeed(new StepResult({ message: "late result", facts: [] })),
              }),
            );
            assert.deepStrictEqual(yield* store.snapshot(runId), settled);
          }),
        ),
    );
  }

  it.live(
    "leaves workflow suspension and defects for restart recovery and preserves cancellation",
    () =>
      withRunStore(
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("unsettled-workflow");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          yield* store.beginAttempt(runId, WorkerName.make("local"));
          const running = yield* store.snapshot(runId);
          yield* store.reconcileCompletion(runId, new Workflow.Suspended({}));
          yield* store.reconcileCompletion(
            runId,
            new Workflow.Complete({ exit: Exit.die(new Error("workflow defect")) }),
          );
          assert.deepStrictEqual(yield* store.snapshot(runId), running);
          assert.deepStrictEqual(yield* store.pendingWorkflowCommands, []);
          const recovered = yield* store.beginAttempt(runId, WorkerName.make("local"));
          assert(recovered._tag === "AttemptStarted");
          assert.strictEqual(recovered.execution.attempt.number, 2);
          const outcome = yield* store.cancel(runId);
          assert(outcome._tag === "Canceled");
          assert.deepStrictEqual(outcome.openAttempt, Option.some(recovered.execution.attempt.id));
          const canceled = yield* store.snapshot(runId);
          const result = new StepResult({ message: "after cancellation", facts: [] });
          yield* store.finishAttempt(recovered.execution.attempt, Result.succeed(result));
          yield* store.reconcileCompletion(
            runId,
            new Workflow.Complete({ exit: Exit.succeed(result) }),
          );
          assert.deepStrictEqual(yield* store.snapshot(runId), canceled);
        }),
      ),
  );

  it.live("rolls back recovery and completion if their final persistence operation fails", () =>
    withRunStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const sql = yield* SqlClient.SqlClient;
        const runId = RunId.make("atomic-lifecycle");
        yield* store.recordAndClaim(lifecycleSubmission, runId);
        yield* store.beginAttempt(runId, WorkerName.make("local"));
        const running = yield* store.snapshot(runId);
        // Reject the new Attempt after recovery has tried closing its predecessor.
        yield* sql`CREATE TRIGGER reject_attempt BEFORE INSERT ON usine_attempts
        BEGIN SELECT RAISE(ABORT, 'attempt insertion unavailable'); END`;
        assert.strictEqual(
          (yield* Effect.flip(store.beginAttempt(runId, WorkerName.make("local"))))._tag,
          "EnginePersistenceError",
        );
        assert.deepStrictEqual(yield* store.snapshot(runId), running);
        yield* sql`DROP TRIGGER reject_attempt`;
        const recovered = yield* store.beginAttempt(runId, WorkerName.make("local"));
        assert(recovered._tag === "AttemptStarted");
        const beforeCompletion = yield* store.snapshot(runId);
        // The outbox insert follows the Attempt, Step result and Run updates.
        yield* sql`CREATE TRIGGER reject_command BEFORE INSERT ON usine_workflow_commands
        BEGIN SELECT RAISE(ABORT, 'workflow command insertion unavailable'); END`;
        const result = new StepResult({ message: "atomic success", facts: [] });
        assert.strictEqual(
          (yield* Effect.flip(
            store.finishAttempt(recovered.execution.attempt, Result.succeed(result)),
          ))._tag,
          "EnginePersistenceError",
        );
        assert.deepStrictEqual(yield* store.snapshot(runId), beforeCompletion);
        assert.deepStrictEqual(yield* store.pendingWorkflowCommands, []);
        yield* sql`DROP TRIGGER reject_command`;
        yield* store.finishAttempt(recovered.execution.attempt, Result.succeed(result));
        const completed = yield* store.snapshot(runId);
        assert.strictEqual(completed.run.state._tag, "Succeeded");
        assert.deepStrictEqual(completed.step.result, Option.some(result));
        assert.deepStrictEqual(
          (yield* store.pendingWorkflowCommands).map(({ command }) => command),
          ["Continue"],
        );
      }),
    ),
  );

  it.live("an approved Run is Queued until its attempt starts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-queued-" }),
      );
      const submission = new Submission({
        event: new Event({
          id: EventId.make("queued-event"),
          dedupKey: DedupKey.make("queued/event/revision"),
          payload: {},
          receivedAt: DateTime.makeUnsafe("2026-09-03T00:00:00Z"),
        }),
        itemKey: ItemKey.make("queued-item"),
        loop: LoopName.make("queued-loop"),
        step: StepName.make("queued-step"),
        approval: "required",
        repository: RepositoryName.make("basaltbytes/usine"),
        revision: RepositoryRevision.make("queued-revision"),
        task: AttemptTask.make("Wait for a worker"),
        agent: testAgent,
        parentModel: Option.none(),
      });
      const approval = new Event({
        id: EventId.make("queued-approval"),
        dedupKey: DedupKey.make("queued/approval"),
        payload: { approved: true },
        receivedAt: DateTime.makeUnsafe("2026-09-03T00:01:00Z"),
      });
      const runId = RunId.make("queued-run");

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const state = () => store.snapshot(runId).pipe(Effect.map(({ run }) => run.state._tag));
        yield* store.recordAndClaim(submission, runId);
        yield* store.parkForApproval(runId);
        assert.strictEqual(yield* state(), "Waiting");

        yield* store.approve(runId, approval);
        assert.strictEqual(yield* state(), "Queued");
        // Re-delivery of the same approval is a no-op, not a rejection.
        yield* store.approve(runId, approval);
        assert.strictEqual(yield* state(), "Queued");

        const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
        assert.strictEqual(started._tag, "AttemptStarted");
        assert.strictEqual(yield* state(), "Running");
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a run closed while queued instead of starting an attempt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-closed-" }),
      );
      const submission = new Submission({
        event: new Event({
          id: EventId.make("closed-event"),
          dedupKey: DedupKey.make("closed/event/revision"),
          payload: {},
          receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
        }),
        itemKey: ItemKey.make("closed-item"),
        loop: LoopName.make("closed-loop"),
        step: StepName.make("closed-step"),
        approval: "none",
        repository: RepositoryName.make("basaltbytes/usine"),
        revision: RepositoryRevision.make("closed-revision"),
        task: AttemptTask.make("Close before starting"),
        agent: testAgent,
        parentModel: Option.none(),
      });
      const runId = RunId.make("closed-run");

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        // With worker capacity, a run routinely closes between claim and begin;
        // that is not a defect.
        const outcome = yield* store.cancel(runId);
        assert.strictEqual(outcome._tag, "Canceled");
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"));
        assert.strictEqual(started._tag, "RunClosed");
        const snapshot = yield* store.snapshot(runId);
        assert.strictEqual(snapshot.attempts.length, 0);
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Item projections", () => {
  it.live("stores the latest polled Item without invalidating unchanged operator reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-item-projection-" }),
      );
      const repository = RepositoryName.make("basaltbytes/usine");
      const item = new ItemProjection({
        itemKey: ItemKey.make("github:basaltbytes/usine:33"),
        repository,
        source: ItemProjectionSource.make("issue"),
        number: ItemNumber.make(33),
        contentHash: ItemContentHash.make("content-1"),
        payload: { number: 33, title: "Board lanes" },
      });
      const database = localSqliteLayer(directory);
      const services = Layer.mergeAll(
        ItemProjectionReader.layer,
        ItemProjectionWriter.layer,
        RunReader.layer,
      ).pipe(Layer.provide(database));

      yield* Effect.gen(function* () {
        const reader = yield* ItemProjectionReader;
        const writer = yield* ItemProjectionWriter;
        const runs = yield* RunReader;
        const before = yield* runs.revision();
        assert(Option.isSome(before));

        assert.strictEqual(yield* writer.upsert(item), true);
        const changed = yield* runs.revision();
        assert(Option.isSome(changed));
        assert.strictEqual(changed.value, before.value + 1);
        assert.deepStrictEqual(yield* reader.list(repository, { limit: 10 }), [item]);

        assert.strictEqual(yield* writer.upsert(item), false);
        assert.deepStrictEqual(yield* runs.revision(), changed);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("repository label projections", () => {
  it.live("stores the complete catalog and invalidates only changed operator reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-label-projection-" }),
      );
      const repository = RepositoryName.make("basaltbytes/usine");
      const projection = new RepositoryLabelProjection({
        repository,
        labels: [
          new RepositoryLabel({
            name: "bug",
            color: Option.some("d73a4a"),
            description: Option.some("Something is broken"),
          }),
          new RepositoryLabel({
            name: "unused-ready-label",
            color: Option.none(),
            description: Option.none(),
          }),
        ],
      });
      const database = localSqliteLayer(directory);
      const services = Layer.mergeAll(
        RepositoryLabelProjectionReader.layer,
        RepositoryLabelProjectionWriter.layer,
        RunReader.layer,
      ).pipe(Layer.provide(database));

      yield* Effect.gen(function* () {
        const reader = yield* RepositoryLabelProjectionReader;
        const writer = yield* RepositoryLabelProjectionWriter;
        const runs = yield* RunReader;
        const before = yield* runs.revision();
        assert(Option.isSome(before));

        assert.strictEqual(yield* writer.replace(projection), true);
        const changed = yield* runs.revision();
        assert(Option.isSome(changed));
        assert.strictEqual(changed.value, before.value + 1);
        assert.deepStrictEqual(yield* reader.get(repository), Option.some(projection));

        assert.strictEqual(yield* writer.replace(projection), false);
        assert.deepStrictEqual(yield* runs.revision(), changed);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const TestCursor = Schema.Struct({ etag: Schema.String });
const StricterCursor = Schema.Struct({ watermark: Schema.String });

describe("cursor store", () => {
  it.live("replaces one cursor durably without exposing database rows", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-cursor-" }),
      );
      const key = CursorKey.make("github:basaltbytes/usine");
      const database = localSqliteLayer(directory);

      yield* Effect.gen(function* () {
        const store = yield* CursorStore;
        assert(Option.isNone(yield* store.read(key, TestCursor)));
        yield* store.write(key, TestCursor, { etag: "first" });
        yield* store.write(key, TestCursor, { etag: "second" });
      }).pipe(Effect.provide(CursorStore.layer), Effect.provide(database));

      yield* Effect.gen(function* () {
        const store = yield* CursorStore;
        const restored = yield* store.read(key, TestCursor);
        assert(Option.isSome(restored));
        assert.deepStrictEqual(restored.value, { etag: "second" });
        // A stored value that no longer decodes must read as absent, never
        // fail: losing a cursor is always safe.
        assert(Option.isNone(yield* store.read(key, StricterCursor)));
      }).pipe(Effect.provide(CursorStore.layer), Effect.provide(database));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "records an Attempt's salvage after any outcome and resumes the retry from a pushed one",
    () =>
      withRunStore(
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("salvaged");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const first = yield* store.beginAttempt(runId, WorkerName.make("local"));
          assert(first._tag === "AttemptStarted");
          assert(Option.isNone(first.execution.salvage));
          // Cancellation closes the Attempt before the executor finishes salvaging.
          yield* store.cancel(runId);
          const pushed = new SalvagePushed({
            ref: SalvageRef.make("usine/salvage/salvaged/1"),
            commit: CommitSha.make("b".repeat(40)),
          });
          yield* store.recordSalvage(first.execution.attempt.id, pushed);
          const canceled = yield* store.snapshot(runId);
          assert.deepStrictEqual(canceled.attempts[0]?.salvage, Option.some(pushed));
          assert.strictEqual(
            canceled.attempts[0]?.outcome.pipe(Option.map((o) => o._tag)).pipe(Option.getOrNull),
            "Canceled",
          );

          // A retry of a failed Run picks up the pushed salvage.
          const retriedRun = RunId.make("salvaged-retry");
          yield* store.recordAndClaim(
            new Submission({
              ...lifecycleSubmission,
              event: new Event({
                ...lifecycleSubmission.event,
                id: EventId.make("salvaged-retry"),
                dedupKey: DedupKey.make("salvaged/retry"),
              }),
              itemKey: ItemKey.make("salvaged-item"),
            }),
            retriedRun,
          );
          const started = yield* store.beginAttempt(retriedRun, WorkerName.make("local"));
          assert(started._tag === "AttemptStarted");
          yield* store.finishAttempt(
            started.execution.attempt,
            Result.fail(new AgentFailure({ message: "Guard tripped" })),
          );
          yield* store.recordSalvage(started.execution.attempt.id, pushed);
          yield* store.retry(retriedRun);
          const resumed = yield* store.beginAttempt(retriedRun, WorkerName.make("local"));
          assert(resumed._tag === "AttemptStarted");
          assert.deepStrictEqual(resumed.execution.salvage, Option.some(pushed));
          assert(Option.isNone(resumed.execution.attempt.salvage));

          // A retained worktree cannot be fetched by the next Worker, so the retry starts fresh.
          yield* store.finishAttempt(
            resumed.execution.attempt,
            Result.fail(new AgentFailure({ message: "Guard tripped again" })),
          );
          yield* store.recordSalvage(
            resumed.execution.attempt.id,
            new SalvageRetained({
              path: "/workers/local/attempts/salvaged-retry",
              commit: Option.some(CommitSha.make("c".repeat(40))),
              message: "remote rejected",
            }),
          );
          yield* store.retry(retriedRun);
          const fresh = yield* store.beginAttempt(retriedRun, WorkerName.make("local"));
          assert(fresh._tag === "AttemptStarted");
          assert(Option.isNone(fresh.execution.salvage));
          assert.strictEqual(
            (yield* store.snapshot(retriedRun)).attempts[1]?.salvage
              .pipe(Option.map((s) => s._tag))
              .pipe(Option.getOrNull),
            "Retained",
          );
        }),
      ),
  );
});

describe("Loop runtime state", () => {
  it.live("persists pause without changing authored Loop files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-loop-runtime-" }),
      );
      const loop = LoopName.make("review");
      const database = localSqliteLayer(directory);

      yield* Effect.gen(function* () {
        const control = yield* LoopControl;
        assert.strictEqual(yield* control.isPaused(loop), false);
        assert.strictEqual((yield* control.pause(loop)).paused, true);
        assert.strictEqual((yield* control.pause(loop)).paused, true);
      }).pipe(Effect.provide(LoopControl.layer), Effect.provide(database));

      yield* Effect.gen(function* () {
        const control = yield* LoopControl;
        assert.strictEqual(yield* control.isPaused(loop), true);
        assert.deepStrictEqual(
          (yield* control.states).map((state) => [state.loop, state.paused]),
          [[loop, true]],
        );
        assert.strictEqual((yield* control.unpause(loop)).paused, false);
      }).pipe(Effect.provide(LoopControl.layer), Effect.provide(database));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
