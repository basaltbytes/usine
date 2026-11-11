import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentName } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ParentSession, TextOutput } from "@usine/core/agent/session";
import { Attempt, AttemptId, AttemptTask, FailureResolution } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { ApprovalSource, RunApproval } from "@usine/core/run/approval";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option, Result } from "effect";
import { TestClock } from "effect/testing";

import { Submission } from "../../src/engine/submission.ts";
import { RunReader } from "../../src/run-reader/run-reader.ts";
import { RunStore } from "../../src/store/store.ts";
import { TranscriptAllQuery } from "../../src/transcript.ts";
import { lifecycleSubmission, testAgent } from "../store/fixtures.ts";
import { WriteFailures, type PersistenceAdapter, withPersistence } from "./adapter.ts";

export const runStoreContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} RunStore contract`, () => {
    it.live("ignores a late completion from an Attempt replaced during recovery", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("late-completion");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const first = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          const recovered = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(first._tag === "AttemptStarted" && recovered._tag === "AttemptStarted");
          yield* store.finishAttempt(
            first.execution.attempt,
            Result.fail(AgentFailure.make({ message: "late failure" })),
          );
          assert.strictEqual((yield* store.snapshot(runId)).run.state._tag, "Running");
          yield* store.finishAttempt(
            first.execution.attempt,
            Result.succeed(StepResult.make({ message: "late", facts: [] })),
          );
          const current = yield* store.snapshot(runId);
          assert.strictEqual(current.run.state._tag, "Running");
          assert(Option.isNone(current.step.result));
          const active = current.attempts[1];
          assert(active !== undefined && Option.isNone(active.outcome));
          yield* store.finishAttempt(
            recovered.execution.attempt,
            Result.succeed(StepResult.make({ message: "current", facts: [] })),
          );
          const finished = yield* store.snapshot(runId);
          yield* store.finishAttempt(
            recovered.execution.attempt,
            Result.succeed(StepResult.make({ message: "duplicate", facts: [] })),
          );
          const currentSnapshot = yield* store.snapshot(runId);
          assert.deepStrictEqual(currentSnapshot, finished);
          assert.strictEqual(finished.run.state._tag, "Succeeded");
        }),
      ),
    );
    it.live(
      "reattaches a live open Attempt after a restart and continues its transcript sequence",
      () =>
        withPersistence(
          adapter,
          Effect.gen(function* () {
            const store = yield* RunStore;
            const runId = RunId.make("reattached");
            yield* store.recordAndClaim(lifecycleSubmission, runId);
            const first = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
            assert(first._tag === "AttemptStarted");
            const attemptId = first.execution.attempt.id;
            const session = ParentSession.make({
              id: AgentSessionId.make("parent"),
              agent: testAgent.name,
              brain: testAgent.brain,
            });
            const emit = (sequence: number, text: string) =>
              store.appendTranscript(
                "outbound",
                AttemptChannel.OutboundEnvelope.make({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId,
                  sequence: AttemptChannel.Sequence.make(sequence),
                  sentAt: DateTime.makeUnsafe("2026-10-08"),
                  payload: AttemptChannel.SessionEvent.make({
                    event: TextOutput.make({ session, text }),
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
            const transcript = yield* store.transcript(TranscriptAllQuery.make({ attemptId }));
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
              Result.succeed(StepResult.make({ message: "finished after the restart", facts: [] })),
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
    it.live("rolls back recovery and completion if their final persistence operation fails", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const failures = yield* WriteFailures;
          const runId = RunId.make("atomic-lifecycle");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          const running = yield* store.snapshot(runId);
          // Reject the new Attempt after recovery has tried closing its predecessor.
          const restoreAttempt = yield* failures.rejectAttemptInsert;
          assert.strictEqual(
            (yield* Effect.flip(store.beginAttempt(runId, WorkerName.make("local"), Option.none())))
              ._tag,
            "EnginePersistenceError",
          );
          const currentSnapshot = yield* store.snapshot(runId);
          assert.deepStrictEqual(currentSnapshot, running);
          yield* restoreAttempt;
          const recovered = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(recovered._tag === "AttemptStarted");
          const beforeCompletion = yield* store.snapshot(runId);
          // The Run's closing state follows the Attempt outcome and the Step result.
          const restoreRun = yield* failures.rejectRunUpdate;
          const result = StepResult.make({ message: "atomic success", facts: [] });
          assert.strictEqual(
            (yield* Effect.flip(
              store.finishAttempt(recovered.execution.attempt, Result.succeed(result)),
            ))._tag,
            "EnginePersistenceError",
          );
          const nextSnapshot = yield* store.snapshot(runId);
          assert.deepStrictEqual(nextSnapshot, beforeCompletion);
          yield* restoreRun;
          yield* store.finishAttempt(recovered.execution.attempt, Result.succeed(result));
          const completed = yield* store.snapshot(runId);
          assert.strictEqual(completed.run.state._tag, "Succeeded");
          assert.deepStrictEqual(
            completed.step.result,
            Option.some(
              StepResult.make({
                ...result,
                attemptId: Option.some(recovered.execution.attempt.id),
              }),
            ),
          );
        }),
      ),
    );
    it.effect(
      "deduplicates concurrent claims and transcript appends without losing committed state",
      () =>
        withPersistence(
          adapter,
          Effect.gen(function* () {
            const store = yield* RunStore;
            const runId = RunId.make("concurrent-claim");
            const claims = yield* Effect.all(
              Array.from({ length: 8 }, () => store.recordAndClaim(lifecycleSubmission, runId)),
              { concurrency: "unbounded" },
            );
            assert.strictEqual(
              claims.filter(({ openedRun }) => Option.isSome(openedRun)).length,
              1,
            );
            assert(
              claims.every(({ result }) => result._tag === "Claimed" && result.runId === runId),
            );
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            const envelope = AttemptChannel.OutboundEnvelope.make({
              version: AttemptChannel.PROTOCOL_VERSION,
              attemptId: started.execution.attempt.id,
              sequence: AttemptChannel.Sequence.make(1),
              sentAt: lifecycleSubmission.event.receivedAt,
              payload: AttemptChannel.Started.make({
                parentModel: Option.some(ModelId.make("concurrent-model")),
              }),
            });
            yield* Effect.all(
              Array.from({ length: 8 }, () => store.appendTranscript("outbound", envelope)),
              { concurrency: "unbounded" },
            );
            const entries = yield* store.transcript(
              TranscriptAllQuery.make({ attemptId: envelope.attemptId }),
            );
            assert.deepStrictEqual(
              entries.map(({ envelope }) => envelope),
              [envelope],
            );
            const result = StepResult.make({ message: "Done", facts: [] });
            yield* Effect.all(
              Array.from({ length: 4 }, () =>
                store.finishAttempt(started.execution.attempt, Result.succeed(result)),
              ),
              { concurrency: "unbounded" },
            );
            const snapshot = yield* store.snapshot(runId);
            assert.strictEqual(snapshot.run.state._tag, "Succeeded");
            assert.deepStrictEqual(
              snapshot.step.result,
              Option.some(
                StepResult.make({
                  ...result,
                  attemptId: Option.some(started.execution.attempt.id),
                }),
              ),
            );
            assert.strictEqual(snapshot.attempts.length, 1);
          }),
        ),
    );
    it.live("rejects a retry while another Run of the same Loop and Item is open", () =>
      withPersistence(
        adapter,
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
            Result.fail(AgentFailure.make({ message: "Needs the operator" })),
          );
          // A Failed Run is closed, so the Item's next Event opens a Run of its own.
          const later = Submission.make({
            ...lifecycleSubmission,
            event: Event.make({
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
          const retryResult = yield* store.retry(failedRun);
          assert.strictEqual(retryResult, true);
          assert.strictEqual((yield* store.snapshot(failedRun)).run.state._tag, "Running");
        }),
      ),
    );
    it.live(
      "caps interrupted Attempts and cancels an operator retry before another Attempt starts",
      () =>
        withPersistence(
          adapter,
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
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("attempt-end-times");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const first = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert(first._tag === "AttemptStarted");
          assert.deepStrictEqual(
            (yield* store.snapshot(runId)).attempts[0]?.endedAt,
            Option.none(),
          );
          yield* store.finishAttempt(
            first.execution.attempt,
            Result.fail(AgentFailure.make({ message: "Checks failed" })),
          );
          yield* store.retry(runId);
          const second = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert(second._tag === "AttemptStarted");
          assert.deepStrictEqual(
            (yield* store.snapshot(runId)).attempts[1]?.endedAt,
            Option.none(),
          );
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
        withPersistence(
          adapter,
          Effect.gen(function* () {
            const store = yield* RunStore;
            const readRun = RunId.make("read-only-review");
            yield* store.recordAndClaim(
              Submission.make({ ...lifecycleSubmission, permissions: "read" }),
              readRun,
            );
            const writeRun = RunId.make("default-write");
            yield* store.recordAndClaim(
              Submission.make({
                ...lifecycleSubmission,
                event: Event.make({
                  ...lifecycleSubmission.event,
                  id: EventId.make("default-write"),
                  dedupKey: DedupKey.make("default/write"),
                }),
                itemKey: ItemKey.make("default-write-item"),
              }),
              writeRun,
            );
            const first = yield* store.beginAttempt(
              readRun,
              WorkerName.make("local"),
              Option.none(),
            );
            assert(first._tag === "AttemptStarted");
            assert.strictEqual(first.execution.permissions, "read");
            yield* store.finishAttempt(
              first.execution.attempt,
              Result.fail(AgentFailure.make({ message: "Checks failed" })),
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
    it.live("stops tracking a closed Attempt once, and never an open one", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("closed-attempt-discard");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const first = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert(first._tag === "AttemptStarted");
          const open = first.execution.attempt.id;
          const whileOpen = yield* store.discardClosedAttempt(open);
          assert.isFalse(whileOpen);

          yield* store.finishAttempt(
            first.execution.attempt,
            Result.fail(AgentFailure.make({ message: "Checks failed" })),
          );
          const closed = yield* store.discardClosedAttempt(open);
          assert.isTrue(closed);
          const again = yield* store.discardClosedAttempt(open);
          assert.isFalse(again);
          const candidates = yield* store.salvageCandidates;
          assert.deepStrictEqual(candidates, []);
          const candidate = yield* store.salvageCandidate(open);
          assert.isTrue(Option.isNone(candidate));
        }),
      ),
    );
    it.live("keeps a canceled Run closed when its recovered Attempt reports late", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("late-after-cancel");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          const recovered = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            Option.none(),
          );
          assert(recovered._tag === "AttemptStarted");
          assert.strictEqual(recovered.execution.attempt.number, 2);
          const outcome = yield* store.cancel(runId);
          assert(outcome._tag === "Canceled");
          assert.deepStrictEqual(
            outcome.openAttempt,
            Option.some({
              id: recovered.execution.attempt.id,
              worker: recovered.execution.attempt.worker,
            }),
          );
          const canceled = yield* store.snapshot(runId);
          yield* store.finishAttempt(
            recovered.execution.attempt,
            Result.succeed(StepResult.make({ message: "after cancellation", facts: [] })),
          );
          const currentSnapshot = yield* store.snapshot(runId);
          assert.deepStrictEqual(currentSnapshot, canceled);
        }),
      ),
    );
    it.effect(
      "gives an Attempt its own window and the windows of its Agent's other Attempts on its Item that overlap it",
      () =>
        withPersistence(
          adapter,
          Effect.gen(function* () {
            const store = yield* RunStore;
            const worker = WorkerName.make("local");
            const claim = (name: string, loop: string, item: string, agent = testAgent) =>
              store
                .recordAndClaim(
                  Submission.make({
                    ...lifecycleSubmission,
                    event: Event.make({
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
                Result.fail(AgentFailure.make({ message: "Checks failed" })),
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
            const claimedRun = yield* claim(
              "review",
              "review",
              "pull-71",
              Agent.make({ ...testAgent, name: AgentName.make("reviewer") }),
            );
            yield* begin(claimedRun);
            yield* TestClock.adjust("2 seconds");
            yield* store.retry(fix);
            const retried = yield* begin(fix);
            const currentClaimedRun = yield* claim("triage", "triage", "pull-71");
            const triage = yield* begin(currentClaimedRun);
            const nextClaimedRun = yield* claim("elsewhere", "fix", "issue-12");
            yield* begin(nextClaimedRun);

            // The first fix Attempt ended a second before either started.
            const currentAttemptWindows = yield* windows(retried);
            assert.deepStrictEqual(currentAttemptWindows, {
              own: Option.some([retried.id, false]),
              overlapping: [[triage.id, false]],
            });
            const nextAttemptWindows = yield* windows(triage);
            assert.deepStrictEqual(nextAttemptWindows, {
              own: Option.some([triage.id, false]),
              overlapping: [[retried.id, false]],
            });
            const updatedAttemptWindows = yield* windows(ended);
            assert.deepStrictEqual(updatedAttemptWindows, {
              own: Option.some([ended.id, true]),
              overlapping: [],
            });
            yield* TestClock.adjust("1 second");
            yield* fail(triage);
            const latestAttemptWindows = yield* windows(retried);
            assert.deepStrictEqual(latestAttemptWindows, {
              own: Option.some([retried.id, false]),
              overlapping: [[triage.id, true]],
            });
            const secondAttemptWindows = yield* windows(triage);
            assert.deepStrictEqual(secondAttemptWindows, {
              own: Option.some([triage.id, true]),
              overlapping: [[retried.id, false]],
            });
          }),
        ),
    );
    it.effect(
      "persists the first failure resolution and operator across restart and retries, and rejects stale attempts",
      () =>
        Effect.gen(function* () {
          const fixture = yield* adapter.fixture;
          yield* TestClock.setTime(DateTime.toEpochMillis(lifecycleSubmission.event.receivedAt));
          const runId = RunId.make("resolved-failure");
          const operator = Option.some(OperatorLogin.make("Philippe"));
          const resolution = Option.some(
            FailureResolution.make({
              resolvedAt: DateTime.makeUnsafe("2026-08-25T00:15:00Z"),
              operator,
            }),
          );
          const services = fixture.open;
          const before = yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* RunStore;
              const reader = yield* RunReader;
              yield* store.recordAndClaim(lifecycleSubmission, runId);
              const rejected = yield* Effect.flip(
                store.resolveFailure(runId, AttemptId.make("not-started"), Option.none()),
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
                (yield* Effect.flip(store.resolveFailure(runId, attempt.id, Option.none())))._tag,
                "RunOperationRejectedError",
              );
              yield* store.appendTranscript(
                "outbound",
                AttemptChannel.OutboundEnvelope.make({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId: attempt.id,
                  sequence: AttemptChannel.Sequence.make(1),
                  sentAt: attempt.startedAt,
                  payload: AttemptChannel.Failed.make({
                    failure: AgentFailure.make({ message: "Handled outside usine" }),
                  }),
                }),
              );
              yield* store.finishAttempt(
                attempt,
                Result.fail(AgentFailure.make({ message: "Handled outside usine" })),
              );
              const evidence = yield* reader.evidence(runId);
              const revision = yield* reader.revision;
              yield* TestClock.adjust("15 minutes");
              yield* store.resolveFailure(runId, attempt.id, operator);
              const resolvedRevision = yield* reader.revision;
              assert(Option.isSome(revision) && Option.isSome(resolvedRevision));
              assert(resolvedRevision.value > revision.value);
              yield* TestClock.adjust("5 minutes");
              yield* store.resolveFailure(runId, attempt.id, Option.none());
              const currentRevision = yield* reader.revision;
              assert.deepStrictEqual(currentRevision, resolvedRevision);
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
              assert.deepStrictEqual(after.snapshot.attempts, [
                Attempt.make({ ...first, failureResolution: resolution }),
              ]);
              assert.deepStrictEqual(after.transcript, before.transcript);
              assert.deepStrictEqual(
                after.snapshot.resolvedFailureAttemptId,
                Option.some(first.id),
              );
              const summaries = yield* reader.list({ closedLimit: 10 });
              assert.deepStrictEqual(summaries[0]?.resolvedFailureAttemptId, Option.some(first.id));
              assert.deepStrictEqual(summaries[0]?.attempts[0]?.failureResolution, resolution);
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
                Result.fail(AgentFailure.make({ message: "New failure" })),
              );
              const stale = yield* Effect.flip(
                store.resolveFailure(runId, first.id, Option.none()),
              );
              assert.strictEqual(stale._tag, "RunOperationRejectedError");
              const current = yield* store.snapshot(runId);
              assert.strictEqual(current.run.state._tag, "Failed");
              assert.strictEqual(current.attempts.length, 2);
              assert.deepStrictEqual(current.resolvedFailureAttemptId, Option.some(first.id));
              yield* store.resolveFailure(runId, started.execution.attempt.id, Option.none());
              const resolvedAgain = yield* store.snapshot(runId);
              assert.deepStrictEqual(resolvedAgain.attempts[0]?.failureResolution, resolution);
              assert.deepStrictEqual(
                resolvedAgain.attempts[1]?.failureResolution,
                Option.some(
                  FailureResolution.make({
                    resolvedAt: yield* DateTime.now,
                    operator: Option.none(),
                  }),
                ),
              );
              assert.deepStrictEqual(
                (yield* store.snapshot(runId)).resolvedFailureAttemptId,
                Option.some(started.execution.attempt.id),
              );
            }).pipe(Effect.provide(services)),
          );
        }).pipe(Effect.scoped),
    );
    it.live("commits the failed state with the capped Attempt", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const event = Event.make({
          id: EventId.make("store-event"),
          dedupKey: DedupKey.make("store/event/revision"),
          payload: {},
          receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
        });
        const submission = Submission.make({
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
        const failure = InfraFailure.make({
          message: "offline",
          cause: new Error("offline"),
        });

        yield* Effect.gen(function* () {
          const store = yield* RunStore;
          yield* store.recordAndClaim(submission, runId);
          for (let number = 1; number <= 3; number += 1) {
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              Option.none(),
            );
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
          const retryResult = yield* store.retry(runId);
          assert.strictEqual(retryResult, true);
          const currentRetryResult = yield* store.retry(runId);
          assert.strictEqual(currentRetryResult, false);
          const restarted = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            Option.none(),
          );
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
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
    it.live("an approved Run records its source once and is Queued until its attempt starts", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const submission = Submission.make({
          event: Event.make({
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
        const approval = Event.make({
          id: EventId.make("queued-approval"),
          dedupKey: DedupKey.make("queued/approval"),
          payload: { approved: true },
          receivedAt: DateTime.makeUnsafe("2026-09-03T00:01:00Z"),
        });
        const runId = RunId.make("queued-run");

        // A UI approval without a configured operator login records only its channel.
        const unnamed = ApprovalSource.make({ channel: "ui", approver: Option.none() });
        const recorded = Option.some(
          RunApproval.make({ approvedAt: approval.receivedAt, source: Option.some(unnamed) }),
        );

        yield* Effect.gen(function* () {
          const store = yield* RunStore;
          const reader = yield* RunReader;
          const state = () => store.snapshot(runId).pipe(Effect.map(({ run }) => run.state._tag));
          yield* store.recordAndClaim(submission, runId);
          yield* store.parkForApproval(runId);
          const runState = yield* state();
          assert.strictEqual(runState, "Waiting");

          yield* store.approve(runId, approval, unnamed);
          const currentRunState = yield* state();
          assert.strictEqual(currentRunState, "Queued");
          // Re-delivery of the same approval is a no-op, not a rejection.
          yield* store.approve(
            runId,
            approval,
            ApprovalSource.make({
              channel: "ui",
              approver: Option.some(OperatorLogin.make("Philippe")),
            }),
          );
          const nextRunState = yield* state();
          assert.strictEqual(nextRunState, "Queued");
          assert.deepStrictEqual((yield* store.snapshot(runId)).approval, recorded);
          const [listed] = yield* reader.list({ closedLimit: 10 });
          assert.deepStrictEqual(listed?.approval, recorded);
          const [history] = yield* reader.forItems([submission.itemKey]);
          assert.deepStrictEqual(history?.approval, recorded);

          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert.strictEqual(started._tag, "AttemptStarted");
          const updatedRunState = yield* state();
          assert.strictEqual(updatedRunState, "Running");
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
    it.live("reports a run closed while queued instead of starting an attempt", () =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        const submission = Submission.make({
          event: Event.make({
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
        }).pipe(Effect.provide(fixture.open));
      }).pipe(Effect.scoped),
    );
  });
};
