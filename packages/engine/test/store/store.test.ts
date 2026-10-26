import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";

import { Agent, AgentName } from "@usine/core/agent";
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
import { type Attempt, AttemptId, AttemptTask } from "@usine/core/attempt";
import {
  SalvagePartlyPushed,
  SalvagePushed,
  SalvageRef,
  SalvageRejected,
  SalvageRetained,
} from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { OperatorLogin } from "@usine/core/operator";
import { RunId } from "@usine/core/run";
import { ApprovalSource, RunApproval } from "@usine/core/run/approval";
import { StepName } from "@usine/core/step";
import { Comment, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";

import { DateTime, Effect, FileSystem, Layer, Option, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";

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
import {
  TranscriptAllQuery,
  TranscriptSessionsQuery,
  TranscriptPageQuery,
} from "../../src/transcript.ts";
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
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              Option.none(),
            );
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
            const revision = yield* reader.revision();
            yield* store.resolveFailure(runId, attempt.id);
            const resolvedRevision = yield* reader.revision();
            assert(Option.isSome(revision) && Option.isSome(resolvedRevision));
            assert(resolvedRevision.value > revision.value);
            yield* store.resolveFailure(runId, attempt.id);
            assert.deepStrictEqual(yield* reader.revision(), resolvedRevision);
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
            // The Run closed when its failed Attempt ended; the retry reopens it.
            assert.isTrue(Option.isSome(first.endedAt));
            assert.deepStrictEqual(after.snapshot.closedAt, first.endedAt);
            assert.deepStrictEqual(history[0]?.closedAt, first.endedAt);
            yield* store.retry(runId);
            assert.isTrue(Option.isNone((yield* store.snapshot(runId)).closedAt));
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              Option.none(),
            );
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

  it.live("lists the settled Runs that closed last, whenever they opened", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "usine-closed-runs-" }),
      );
      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const reader = yield* RunReader;
        const claim = (name: string) => {
          const runId = RunId.make(name);
          return store
            .recordAndClaim(
              new Submission({
                ...lifecycleSubmission,
                event: new Event({
                  ...lifecycleSubmission.event,
                  id: EventId.make(name),
                  dedupKey: DedupKey.make(`${name}/revision`),
                }),
                itemKey: ItemKey.make(name),
              }),
              runId,
            )
            .pipe(
              Effect.as(runId),
              Effect.tap(() => Effect.sleep("5 millis")),
            );
        };
        const begin = (runId: RunId) =>
          store
            .beginAttempt(runId, WorkerName.make("local"), Option.none())
            .pipe(
              Effect.flatMap((started) =>
                started._tag === "AttemptStarted"
                  ? Effect.succeed(started.execution.attempt)
                  : Effect.die(`Run ${runId} did not start`),
              ),
            );
        const finish = (attempt: Attempt) =>
          store
            .finishAttempt(attempt, Result.succeed(new StepResult({ message: "Done", facts: [] })))
            .pipe(Effect.tap(() => Effect.sleep("5 millis")));

        // The Run that opened first closes last, as a Run retried hours later does.
        const old = yield* claim("opened-first");
        const oldAttempt = yield* begin(old);
        const middle = yield* claim("opened-second");
        yield* finish(yield* begin(middle));
        const newest = yield* claim("opened-third");
        yield* finish(yield* begin(newest));
        yield* finish(oldAttempt);

        assert.deepStrictEqual(
          (yield* reader.closed({ limit: 2 })).map(({ run }) => run.id),
          [old, newest],
        );
        // Ordered by opening, the same window misses the Run that closed last.
        assert.deepStrictEqual(
          (yield* reader.list({ closedLimit: 2 })).map(({ run }) => run.id),
          [newest, middle],
        );
        const newestClosedAt = (yield* store.snapshot(newest)).closedAt;
        assert(Option.isSome(newestClosedAt));
        assert.deepStrictEqual(
          (yield* reader.closedSince(newestClosedAt)).map(({ run }) => run.id),
          [old, newest],
        );
        assert.deepStrictEqual(
          (yield* reader.closedSince(Option.none())).map(({ run }) => run.id),
          [old, newest, middle],
        );

        // A Run canceled before any Attempt closes at the cancel time, not at its open time.
        const waited = yield* claim("waited-for-approval");
        yield* finish(yield* begin(yield* claim("finished-meanwhile")));
        yield* store.cancel(waited);
        const canceled = yield* store.snapshot(waited);
        assert.strictEqual(canceled.attempts.length, 0);
        assert.isTrue(
          Option.exists(
            canceled.closedAt,
            (closedAt) =>
              DateTime.toEpochMillis(closedAt) > DateTime.toEpochMillis(canceled.run.openedAt),
          ),
        );
        assert.strictEqual((yield* reader.closed({ limit: 1 }))[0]?.run.id, waited);
      }).pipe(
        Effect.provide(Layer.mergeAll(RunStore.layer, RunReader.layer)),
        Effect.provide(localSqliteLayer(directory)),
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
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
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
        const first = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        const recovered = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
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

  it.live(
    "reattaches a live open Attempt after a restart and continues its transcript sequence",
    () =>
      withRunStore(
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("reattached");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const first = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert(first._tag === "AttemptStarted");
          const attemptId = first.execution.attempt.id;
          const session = new ParentSession({
            id: AgentSessionId.make("parent"),
            agent: testAgent.name,
            brain: testAgent.brain,
          });
          const emit = (sequence: number, text: string) =>
            store.appendTranscript(
              "outbound",
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId,
                sequence: AttemptChannel.Sequence.make(sequence),
                sentAt: DateTime.makeUnsafe("2026-10-08"),
                payload: new AttemptChannel.SessionEvent({
                  event: new TextOutput({ session, text }),
                }),
              }),
            );
          yield* emit(1, "before the restart");
          yield* emit(2, "last before the restart");
          // The restarted Run's fiber checks again whether the open Attempt's parent task is live.
          const reattached = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            Option.some(attemptId),
          );
          assert(reattached._tag === "AttemptStarted");
          assert.strictEqual(reattached.execution.attempt.id, attemptId);
          assert.strictEqual(reattached.execution.reattach, true);
          yield* emit(2, "redelivered after the restart");
          yield* emit(3, "after the restart");
          const transcript = yield* store.transcript(new TranscriptAllQuery({ attemptId }));
          assert.deepStrictEqual(
            transcript.map(({ envelope }) =>
              envelope.payload._tag === "SessionEvent" &&
              envelope.payload.event._tag === "TextOutput"
                ? [envelope.sequence, envelope.payload.event.text]
                : [envelope.sequence, envelope.payload._tag],
            ),
            [
              [1, "before the restart"],
              [2, "last before the restart"],
              [3, "after the restart"],
            ],
          );
          yield* store.finishAttempt(
            reattached.execution.attempt,
            Result.succeed(new StepResult({ message: "finished after the restart", facts: [] })),
          );
          const finished = yield* store.snapshot(runId);
          assert.strictEqual(finished.run.state._tag, "Succeeded");
          assert.deepStrictEqual(
            finished.attempts.map(({ id, number }) => [id, number]),
            [[attemptId, 1]],
          );
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
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert.strictEqual(started._tag, "AttemptStarted");
          if (started._tag !== "AttemptStarted") return;
          assert.deepStrictEqual(started.execution.attempt.brain, testAgent.brain);
          assert.deepStrictEqual(started.execution.attempt.parentModel, Option.none());
          assert.strictEqual(
            (yield* store.finishAttempt(started.execution.attempt, Result.fail(failure)))._tag,
            number < 3 ? "RetryAttempt" : "RunFailed",
          );
        }
        const snapshot = yield* store.snapshot(runId);
        assert.strictEqual(snapshot.itemKey, submission.itemKey);
        assert.strictEqual(snapshot.run.state._tag, "Failed");
        assert.strictEqual(snapshot.attempts.length, 3);
        assert(snapshot.attempts.every((attempt) => Option.isSome(attempt.outcome)));
        assert(Option.isNone(snapshot.step.result));

        // A repeated retry is accepted until the reopened Run starts its next Attempt.
        assert.strictEqual(yield* store.retry(runId), true);
        assert.strictEqual(yield* store.retry(runId), false);
        const restarted = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(restarted._tag === "AttemptStarted");
        assert.strictEqual(restarted.execution.attempt.number, 4);
        assert.strictEqual(
          (yield* Effect.flip(store.retry(runId)))._tag,
          "RunOperationRejectedError",
        );
        assert.strictEqual(
          (yield* store.finishAttempt(restarted.execution.attempt, Result.fail(failure)))._tag,
          "RunFailed",
        );
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a retry while another Run of the same Loop and Item is open", () =>
    withRunStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const failedRun = RunId.make("retry-blocked-failed");
        const openRun = RunId.make("retry-blocked-open");
        yield* store.recordAndClaim(lifecycleSubmission, failedRun);
        const started = yield* store.beginAttempt(
          failedRun,
          WorkerName.make("local"),
          Option.none(),
        );
        assert(started._tag === "AttemptStarted");
        yield* store.finishAttempt(
          started.execution.attempt,
          Result.fail(new AgentFailure({ message: "Needs the operator" })),
        );
        // A Failed Run is closed, so the Item's next Event opens a Run of its own.
        const later = new Submission({
          ...lifecycleSubmission,
          event: new Event({
            id: EventId.make("retry-blocked-later"),
            dedupKey: DedupKey.make("lifecycle/event/later-revision"),
            payload: {},
            receivedAt: DateTime.makeUnsafe("2026-08-25T01:00:00Z"),
          }),
        });
        const claim = yield* store.recordAndClaim(later, openRun);
        assert.deepStrictEqual(claim.openedRun, Option.some(openRun));

        const blocked = yield* Effect.flip(store.retry(failedRun));
        assert(blocked._tag === "RunRetryBlockedError");
        assert.strictEqual(blocked.openRunId, openRun);
        assert.include(blocked.message, openRun);
        assert.strictEqual((yield* store.snapshot(failedRun)).run.state._tag, "Failed");

        yield* store.cancel(openRun);
        assert.strictEqual(yield* store.retry(failedRun), true);
        assert.strictEqual((yield* store.snapshot(failedRun)).run.state._tag, "Running");
      }),
    ),
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
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            assert.strictEqual(started.execution.attempt.number, number);
          }
          const exhausted = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            Option.none(),
          );
          assert.strictEqual(exhausted._tag, "AttemptRecoveryFailed");
          const failed = yield* store.snapshot(runId);
          assert.strictEqual(failed.run.state._tag, "Failed");
          assert.strictEqual(failed.attempts.length, 3);
          for (const attempt of failed.attempts) {
            assert(Option.isSome(attempt.outcome) && attempt.outcome.value._tag === "Failed");
            assert.strictEqual(attempt.outcome.value.failure._tag, "InfraFailure");
          }
          yield* store.retry(runId);
          const canceled = yield* store.cancel(runId);
          assert(canceled._tag === "Canceled" && Option.isNone(canceled.openAttempt));
          assert.strictEqual(
            (yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none()))._tag,
            "RunClosed",
          );
          assert.deepStrictEqual((yield* store.snapshot(runId)).attempts, failed.attempts);
        }),
      ),
  );

  it.live("records when an Attempt ends, whether it fails or its Run is canceled", () =>
    withRunStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const runId = RunId.make("attempt-end-times");
        yield* store.recordAndClaim(lifecycleSubmission, runId);
        const first = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(first._tag === "AttemptStarted");
        assert.deepStrictEqual((yield* store.snapshot(runId)).attempts[0]?.endedAt, Option.none());
        yield* store.finishAttempt(
          first.execution.attempt,
          Result.fail(new AgentFailure({ message: "Checks failed" })),
        );
        yield* store.retry(runId);
        const second = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(second._tag === "AttemptStarted");
        assert.deepStrictEqual((yield* store.snapshot(runId)).attempts[1]?.endedAt, Option.none());
        yield* store.cancel(runId);
        const attempts = (yield* store.snapshot(runId)).attempts;
        assert.deepStrictEqual(
          attempts.map(({ outcome }) => Option.map(outcome, ({ _tag }) => _tag)),
          [Option.some("Failed"), Option.some("Canceled")],
        );
        for (const attempt of attempts) {
          assert(Option.isSome(attempt.endedAt));
          assert(DateTime.isGreaterThanOrEqualTo(attempt.endedAt.value, attempt.startedAt));
        }
      }),
    ),
  );

  it.live(
    "keeps the Loop's permissions with the Event, so each Attempt and its recovery use them",
    () =>
      withRunStore(
        Effect.gen(function* () {
          const store = yield* RunStore;
          const readRun = RunId.make("read-only-review");
          yield* store.recordAndClaim(
            new Submission({ ...lifecycleSubmission, permissions: "read" }),
            readRun,
          );
          const writeRun = RunId.make("default-write");
          yield* store.recordAndClaim(
            new Submission({
              ...lifecycleSubmission,
              event: new Event({
                ...lifecycleSubmission.event,
                id: EventId.make("default-write"),
                dedupKey: DedupKey.make("default/write"),
              }),
              itemKey: ItemKey.make("default-write-item"),
            }),
            writeRun,
          );
          const first = yield* store.beginAttempt(readRun, WorkerName.make("local"), Option.none());
          assert(first._tag === "AttemptStarted");
          assert.strictEqual(first.execution.permissions, "read");
          yield* store.finishAttempt(
            first.execution.attempt,
            Result.fail(new AgentFailure({ message: "Checks failed" })),
          );
          yield* store.retry(readRun);
          const retried = yield* store.beginAttempt(
            readRun,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(retried._tag === "AttemptStarted");
          assert.strictEqual(retried.execution.permissions, "read");
          assert.strictEqual((yield* store.snapshot(readRun)).permissions, "read");

          const written = yield* store.beginAttempt(
            writeRun,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(written._tag === "AttemptStarted");
          assert.strictEqual(written.execution.permissions, "write");

          const candidates = yield* store.salvageCandidates;
          assert.deepStrictEqual(
            new Map(candidates.map(({ attemptId, permissions }) => [attemptId, permissions])),
            new Map([
              [first.execution.attempt.id, "read"],
              [retried.execution.attempt.id, "read"],
              [written.execution.attempt.id, "write"],
            ]),
          );
        }),
      ),
  );

  it.live("keeps a canceled Run closed when its recovered Attempt reports late", () =>
    withRunStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const runId = RunId.make("late-after-cancel");
        yield* store.recordAndClaim(lifecycleSubmission, runId);
        yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        const recovered = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(recovered._tag === "AttemptStarted");
        assert.strictEqual(recovered.execution.attempt.number, 2);
        const outcome = yield* store.cancel(runId);
        assert(outcome._tag === "Canceled");
        assert.deepStrictEqual(outcome.openAttempt, Option.some(recovered.execution.attempt.id));
        const canceled = yield* store.snapshot(runId);
        yield* store.finishAttempt(
          recovered.execution.attempt,
          Result.succeed(new StepResult({ message: "after cancellation", facts: [] })),
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
        yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        const running = yield* store.snapshot(runId);
        // Reject the new Attempt after recovery has tried closing its predecessor.
        yield* sql`CREATE TRIGGER reject_attempt BEFORE INSERT ON usine_attempts
        BEGIN SELECT RAISE(ABORT, 'attempt insertion unavailable'); END`;
        assert.strictEqual(
          (yield* Effect.flip(store.beginAttempt(runId, WorkerName.make("local"), Option.none())))
            ._tag,
          "EnginePersistenceError",
        );
        assert.deepStrictEqual(yield* store.snapshot(runId), running);
        yield* sql`DROP TRIGGER reject_attempt`;
        const recovered = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(recovered._tag === "AttemptStarted");
        const beforeCompletion = yield* store.snapshot(runId);
        // The Run's closing state follows the Attempt outcome and the Step result.
        yield* sql`CREATE TRIGGER reject_closing BEFORE UPDATE ON usine_runs
        BEGIN SELECT RAISE(ABORT, 'run update unavailable'); END`;
        const result = new StepResult({ message: "atomic success", facts: [] });
        assert.strictEqual(
          (yield* Effect.flip(
            store.finishAttempt(recovered.execution.attempt, Result.succeed(result)),
          ))._tag,
          "EnginePersistenceError",
        );
        assert.deepStrictEqual(yield* store.snapshot(runId), beforeCompletion);
        yield* sql`DROP TRIGGER reject_closing`;
        yield* store.finishAttempt(recovered.execution.attempt, Result.succeed(result));
        const completed = yield* store.snapshot(runId);
        assert.strictEqual(completed.run.state._tag, "Succeeded");
        assert.deepStrictEqual(completed.step.result, Option.some(result));
      }),
    ),
  );

  it.live("an approved Run records its source once and is Queued until its attempt starts", () =>
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

      // A UI approval without a configured operator login records only its channel.
      const unnamed = new ApprovalSource({ channel: "ui", approver: Option.none() });
      const recorded = Option.some(
        new RunApproval({ approvedAt: approval.receivedAt, source: Option.some(unnamed) }),
      );

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        const reader = yield* RunReader;
        const state = () => store.snapshot(runId).pipe(Effect.map(({ run }) => run.state._tag));
        yield* store.recordAndClaim(submission, runId);
        yield* store.parkForApproval(runId);
        assert.strictEqual(yield* state(), "Waiting");

        yield* store.approve(runId, approval, unnamed);
        assert.strictEqual(yield* state(), "Queued");
        // Re-delivery of the same approval is a no-op, not a rejection.
        yield* store.approve(
          runId,
          approval,
          new ApprovalSource({
            channel: "github-ask",
            approver: Option.some(OperatorLogin.make("Philippe")),
          }),
        );
        assert.strictEqual(yield* state(), "Queued");
        assert.deepStrictEqual((yield* store.snapshot(runId)).approval, recorded);
        const [listed] = yield* reader.list({ closedLimit: 10 });
        assert.deepStrictEqual(listed?.approval, recorded);
        const [history] = yield* reader.forItems([submission.itemKey]);
        assert.deepStrictEqual(history?.approval, recorded);

        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert.strictEqual(started._tag, "AttemptStarted");
        assert.strictEqual(yield* state(), "Running");
      }).pipe(
        Effect.provide(Layer.mergeAll(RunStore.layer, RunReader.layer)),
        Effect.provide(localSqliteLayer(directory)),
      );
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
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
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

  it.live("records an Item GitHub no longer has as gone until a poll observes it again", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-item-projection-gone-" }),
      );
      const repository = RepositoryName.make("basaltbytes/usine");
      const item = new ItemProjection({
        itemKey: ItemKey.make("github:basaltbytes/usine:28"),
        repository,
        source: ItemProjectionSource.make("pr"),
        number: ItemNumber.make(28),
        contentHash: ItemContentHash.make("content-28"),
        payload: { number: 28, state: "OPEN" },
      });
      const goneAt = DateTime.makeUnsafe("2026-10-19T12:00:00Z");
      const services = Layer.mergeAll(
        ItemProjectionReader.layer,
        ItemProjectionWriter.layer,
        RunReader.layer,
      ).pipe(Layer.provide(localSqliteLayer(directory)));

      yield* Effect.gen(function* () {
        const reader = yield* ItemProjectionReader;
        const writer = yield* ItemProjectionWriter;
        const runs = yield* RunReader;
        assert.strictEqual(yield* writer.markGone(item.itemKey, goneAt), false);
        yield* writer.upsert(item);
        const before = yield* runs.revision();

        assert.strictEqual(yield* writer.markGone(item.itemKey, goneAt), true);
        const gone = new ItemProjection({ ...item, goneAt: Option.some(goneAt) });
        assert.deepStrictEqual(yield* reader.list(repository, { limit: 10 }), [gone]);
        assert(Option.isSome(before));
        assert.deepStrictEqual(yield* runs.revision(), Option.some(before.value + 1));
        assert.strictEqual(
          yield* writer.markGone(item.itemKey, DateTime.makeUnsafe("2026-10-19T13:00:00Z")),
          false,
        );
        assert.deepStrictEqual(yield* reader.list(repository, { limit: 10 }), [gone]);

        // The same content observed again means GitHub has the Item after all.
        assert.strictEqual(yield* writer.upsert(item), true);
        assert.deepStrictEqual(yield* reader.list(repository, { limit: 10 }), [item]);
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("lists the open issues of one repository that are not marked gone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-item-projection-open-" }),
      );
      const repository = RepositoryName.make("basaltbytes/usine");
      const projection = (
        source: "issue" | "pr",
        number: number,
        state: string,
        owner: RepositoryName = repository,
      ) =>
        new ItemProjection({
          itemKey: ItemKey.make(`github:${owner}:${number}`),
          repository: owner,
          source: ItemProjectionSource.make(source),
          number: ItemNumber.make(number),
          contentHash: ItemContentHash.make(`content-${number}`),
          payload: { number, state },
        });
      const services = Layer.mergeAll(ItemProjectionReader.layer, ItemProjectionWriter.layer).pipe(
        Layer.provide(localSqliteLayer(directory)),
      );

      yield* Effect.gen(function* () {
        const reader = yield* ItemProjectionReader;
        const writer = yield* ItemProjectionWriter;
        for (const stored of [
          projection("issue", 28, "OPEN"),
          projection("issue", 12, "OPEN"),
          projection("issue", 29, "CLOSED"),
          projection("pr", 30, "OPEN"),
          projection("issue", 31, "OPEN"),
          projection("issue", 32, "OPEN", RepositoryName.make("basaltbytes/other")),
        ]) {
          yield* writer.upsert(stored);
        }
        yield* writer.markGone(
          ItemKey.make(`github:${repository}:31`),
          DateTime.makeUnsafe("2026-10-20T12:00:00Z"),
        );
        assert.deepStrictEqual(yield* reader.openIssues(repository), [
          ItemNumber.make(12),
          ItemNumber.make(28),
        ]);
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
        // A stored value that no longer decodes reads as `None` instead of failing.
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
          const first = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert(first._tag === "AttemptStarted");
          assert(Option.isNone(first.execution.resume));
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
          assert.deepStrictEqual(
            (yield* store.salvageCandidates).map(({ attemptId, ref, succeeded }) => ({
              attemptId,
              ref,
              succeeded,
            })),
            [{ attemptId: first.execution.attempt.id, ref: pushed.ref, succeeded: false }],
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
          const started = yield* store.beginAttempt(
            retriedRun,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(started._tag === "AttemptStarted");
          yield* store.finishAttempt(
            started.execution.attempt,
            Result.fail(new AgentFailure({ message: "Guard tripped" })),
          );
          yield* store.recordSalvage(started.execution.attempt.id, pushed);
          yield* store.retry(retriedRun);
          const resumed = yield* store.beginAttempt(
            retriedRun,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(resumed._tag === "AttemptStarted");
          assert.deepStrictEqual(resumed.execution.resume, Option.some(pushed));
          assert(Option.isNone(resumed.execution.attempt.salvage));

          // A retained worktree cannot be fetched by the next Worker, so the
          // retry resumes from the newest pushed salvage instead.
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
          const fresh = yield* store.beginAttempt(
            retriedRun,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(fresh._tag === "AttemptStarted");
          assert.deepStrictEqual(fresh.execution.resume, Option.some(pushed));
          assert.strictEqual(
            (yield* store.snapshot(retriedRun)).attempts[1]?.salvage
              .pipe(Option.map((s) => s._tag))
              .pipe(Option.getOrNull),
            "Retained",
          );

          // A salvage that pushed the work without a file larger than GitHub accepts keeps the
          // checkout of that file, and the retry resumes from the pushed part.
          yield* store.finishAttempt(
            fresh.execution.attempt,
            Result.fail(new AgentFailure({ message: "Guard tripped a third time" })),
          );
          const partlyPushed = new SalvagePartlyPushed({
            ref: SalvageRef.make("usine/salvage/salvaged-retry/3"),
            commit: CommitSha.make("d".repeat(40)),
            path: "/workers/local/attempts/salvaged-retry-3",
            message:
              "The checkout has files larger than GitHub's 100 MiB limit, which the salvage can't push: dataset.csv (100.0 MiB)",
          });
          yield* store.recordSalvage(fresh.execution.attempt.id, partlyPushed);
          yield* store.retry(retriedRun);
          const afterPartial = yield* store.beginAttempt(
            retriedRun,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(afterPartial._tag === "AttemptStarted");
          assert.deepStrictEqual(
            afterPartial.execution.resume,
            Option.some(new SalvagePushed({ ref: partlyPushed.ref, commit: partlyPushed.commit })),
          );
          assert.deepStrictEqual(
            (yield* store.snapshot(retriedRun)).attempts[2]?.salvage,
            Option.some(partlyPushed),
          );

          // A succeeded Attempt stays a candidate: a checkout its Worker could
          // not release at the time is removed at the next reconcile, not salvaged.
          yield* store.finishAttempt(
            afterPartial.execution.attempt,
            Result.succeed(new StepResult({ message: "delivered", facts: [] })),
          );
          // A recovery whose push GitHub refused records the rejection, and the next startup's
          // recovery gets it, so it doesn't push the same commit again.
          const rejected = new SalvageRejected({
            path: "/workers/local/attempts/salvaged-retry",
            commit: CommitSha.make("c".repeat(40)),
            message: "remote: error: GH001: Large files detected.",
          });
          yield* store.recordSalvage(resumed.execution.attempt.id, rejected);
          const candidates = yield* store.salvageCandidates;
          assert.strictEqual(candidates.length, 5);
          assert.deepStrictEqual(
            Object.fromEntries(
              candidates.map(({ attemptId, succeeded, rejected }) => [
                attemptId,
                { succeeded, rejected },
              ]),
            ),
            {
              [first.execution.attempt.id]: { succeeded: false, rejected: Option.none() },
              [started.execution.attempt.id]: { succeeded: false, rejected: Option.none() },
              [resumed.execution.attempt.id]: { succeeded: false, rejected: Option.some(rejected) },
              [fresh.execution.attempt.id]: { succeeded: false, rejected: Option.none() },
              [afterPartial.execution.attempt.id]: { succeeded: true, rejected: Option.none() },
            },
          );
        }),
      ),
  );

  it.live("records the comments an Attempt posted before it failed, on that Attempt", () =>
    withRunStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const runId = RunId.make("commented");
        yield* store.recordAndClaim(lifecycleSubmission, runId);
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(started._tag === "AttemptStarted");
        const review = new Comment({
          url: new URL("https://github.com/basaltbytes/usine/pull/71#pullrequestreview-9"),
          kind: "review",
          at: Option.some(DateTime.makeUnsafe("2026-10-20T10:00:00.000Z")),
        });
        yield* store.recordComments(started.execution.attempt.id, [review]);
        yield* store.finishAttempt(
          started.execution.attempt,
          Result.fail(new AgentFailure({ message: "Checks failed" })),
        );
        yield* store.retry(runId);
        const retried = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(retried._tag === "AttemptStarted");

        const attempts = (yield* store.snapshot(runId)).attempts;
        assert.deepStrictEqual(attempts[0]?.comments, [review]);
        // An Attempt without recorded comments, like every Attempt from before they were stored, reads as empty.
        assert.deepStrictEqual(attempts[1]?.comments, []);
        assert(Option.isNone((yield* store.snapshot(runId)).step.result));
      }),
    ),
  );

  // Two Loops' Runs of one Agent on one Item sign their comments the same way (#429).
  it.effect(
    "gives an Attempt its own window and the windows of its Agent's other Attempts on its Item that overlap it",
    () =>
      withRunStore(
        Effect.gen(function* () {
          const store = yield* RunStore;
          const worker = WorkerName.make("local");
          const claim = (name: string, loop: string, item: string, agent = testAgent) =>
            store
              .recordAndClaim(
                new Submission({
                  ...lifecycleSubmission,
                  event: new Event({
                    ...lifecycleSubmission.event,
                    id: EventId.make(name),
                    dedupKey: DedupKey.make(`${name}/revision`),
                  }),
                  loop: LoopName.make(loop),
                  itemKey: ItemKey.make(item),
                  agent,
                }),
                RunId.make(name),
              )
              .pipe(Effect.as(RunId.make(name)));
          const begin = (runId: RunId) =>
            store
              .beginAttempt(runId, worker, Option.none())
              .pipe(
                Effect.flatMap((started) =>
                  started._tag === "AttemptStarted"
                    ? Effect.succeed(started.execution.attempt)
                    : Effect.die(`Run ${runId} did not start`),
                ),
              );
          const fail = (attempt: Attempt) =>
            store.finishAttempt(
              attempt,
              Result.fail(new AgentFailure({ message: "Checks failed" })),
            );
          // Each window as its Attempt ID and whether it has ended.
          const windows = (attempt: Attempt) =>
            store.attemptWindows(attempt.id).pipe(
              Effect.map(({ own, overlapping }) => ({
                own: Option.map(own, ({ attemptId, endedAt }) => [
                  attemptId,
                  Option.isSome(endedAt),
                ]),
                overlapping: overlapping.map(({ attemptId, endedAt }) => [
                  attemptId,
                  Option.isSome(endedAt),
                ]),
              })),
            );

          const fix = yield* claim("fix", "fix", "pull-71");
          const ended = yield* begin(fix);
          yield* fail(ended);
          // Another Agent signs differently, so its Attempts are never listed.
          yield* begin(
            yield* claim(
              "review",
              "review",
              "pull-71",
              new Agent({ ...testAgent, name: AgentName.make("reviewer") }),
            ),
          );
          yield* TestClock.adjust("2 seconds");
          yield* store.retry(fix);
          const retried = yield* begin(fix);
          const triage = yield* begin(yield* claim("triage", "triage", "pull-71"));
          yield* begin(yield* claim("elsewhere", "fix", "issue-12"));

          // The first fix Attempt ended a second before either started.
          assert.deepStrictEqual(yield* windows(retried), {
            own: Option.some([retried.id, false]),
            overlapping: [[triage.id, false]],
          });
          assert.deepStrictEqual(yield* windows(triage), {
            own: Option.some([triage.id, false]),
            overlapping: [[retried.id, false]],
          });
          assert.deepStrictEqual(yield* windows(ended), {
            own: Option.some([ended.id, true]),
            overlapping: [],
          });
          yield* TestClock.adjust("1 second");
          yield* fail(triage);
          assert.deepStrictEqual(yield* windows(retried), {
            own: Option.some([retried.id, false]),
            overlapping: [[triage.id, true]],
          });
          assert.deepStrictEqual(yield* windows(triage), {
            own: Option.some([triage.id, true]),
            overlapping: [[retried.id, false]],
          });
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
