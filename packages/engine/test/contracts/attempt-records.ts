import { assert, describe, it } from "@effect/vitest";
import {
  ContainerOutOfMemoryKills,
  MemoryKilledProcess,
  OutOfMemoryKills,
} from "@usine/core/attempt";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import {
  SalvagePartlyPushed,
  SalvagePushed,
  SalvageRef,
  SalvageRejected,
  SalvageRetained,
} from "@usine/core/attempt/salvage";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { CommitSha } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { Comment, StepResult } from "@usine/core/step/result";
import { ContainerId, ContainerMemoryMib, WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option, Result } from "effect";

import { Submission } from "../../src/engine/submission.ts";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission } from "../store/fixtures.ts";
import { type PersistenceAdapter, withPersistence } from "./adapter.ts";

export const attemptRecordsContract = (adapter: PersistenceAdapter) => {
  describe(`${adapter.name} RunStore attempt records contract`, () => {
    it.live(
      "records an Attempt's salvage after any outcome and resumes the retry from a pushed one",
      () =>
        withPersistence(
          adapter,
          Effect.gen(function* () {
            const store = yield* RunStore;
            const runId = RunId.make("salvaged");
            yield* store.recordAndClaim(lifecycleSubmission, runId);
            const first = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              "local",
              Option.none(),
            );
            assert(first._tag === "AttemptStarted");
            assert(Option.isNone(first.execution.resume));
            // Cancellation closes the Attempt before the executor finishes salvaging.
            yield* store.cancel(runId);
            const pushed = SalvagePushed.make({
              ref: SalvageRef.make("usine/salvage/salvaged/1"),
              commit: CommitSha.make("b".repeat(40)),
            });
            yield* store.recordSalvage(first.execution.attempt.id, pushed);
            const canceled = yield* store.snapshot(runId);
            assert.deepStrictEqual(canceled.attempts[0]?.salvage, Option.some(pushed));
            assert.strictEqual(
              canceled.attempts[0]?.outcome.pipe(
                Option.map((o) => o._tag),
                Option.getOrNull,
              ),
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
              Submission.make({
                ...lifecycleSubmission,
                event: Event.make({
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
              "local",
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            yield* store.finishAttempt(
              started.execution.attempt,
              Result.fail(AgentFailure.make({ message: "Guard tripped" })),
            );
            yield* store.recordSalvage(started.execution.attempt.id, pushed);
            yield* store.retry(retriedRun);
            const resumed = yield* store.beginAttempt(
              retriedRun,
              WorkerName.make("local"),
              "local",
              Option.none(),
            );
            assert(resumed._tag === "AttemptStarted");
            assert.deepStrictEqual(resumed.execution.resume, Option.some(pushed));
            assert(Option.isNone(resumed.execution.attempt.salvage));

            // A retained worktree cannot be fetched by the next Worker, so the
            // retry resumes from the newest pushed salvage instead.
            yield* store.finishAttempt(
              resumed.execution.attempt,
              Result.fail(AgentFailure.make({ message: "Guard tripped again" })),
            );
            yield* store.recordSalvage(
              resumed.execution.attempt.id,
              SalvageRetained.make({
                path: "/workers/local/attempts/salvaged-retry",
                commit: Option.some(CommitSha.make("c".repeat(40))),
                message: "remote rejected",
              }),
            );
            yield* store.retry(retriedRun);
            const fresh = yield* store.beginAttempt(
              retriedRun,
              WorkerName.make("local"),
              "local",
              Option.none(),
            );
            assert(fresh._tag === "AttemptStarted");
            assert.deepStrictEqual(fresh.execution.resume, Option.some(pushed));
            assert.strictEqual(
              (yield* store.snapshot(retriedRun)).attempts[1]?.salvage.pipe(
                Option.map((s) => s._tag),
                Option.getOrNull,
              ),
              "Retained",
            );

            // A salvage that pushed the work without a file larger than GitHub accepts keeps the
            // checkout of that file, and the retry resumes from the pushed part.
            yield* store.finishAttempt(
              fresh.execution.attempt,
              Result.fail(AgentFailure.make({ message: "Guard tripped a third time" })),
            );
            const partlyPushed = SalvagePartlyPushed.make({
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
              "local",
              Option.none(),
            );
            assert(afterPartial._tag === "AttemptStarted");
            assert.deepStrictEqual(
              afterPartial.execution.resume,
              Option.some(
                SalvagePushed.make({ ref: partlyPushed.ref, commit: partlyPushed.commit }),
              ),
            );
            assert.deepStrictEqual(
              (yield* store.snapshot(retriedRun)).attempts[2]?.salvage,
              Option.some(partlyPushed),
            );

            // A succeeded Attempt stays a candidate: a checkout its Worker could
            // not release at the time is removed at the next reconcile, not salvaged.
            yield* store.finishAttempt(
              afterPartial.execution.attempt,
              Result.succeed(StepResult.make({ message: "delivered", facts: [] })),
            );
            // A recovery whose push GitHub refused records the rejection, and the next startup's
            // recovery gets it, so it doesn't push the same commit again.
            const rejected = SalvageRejected.make({
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
                [resumed.execution.attempt.id]: {
                  succeeded: false,
                  rejected: Option.some(rejected),
                },
                [fresh.execution.attempt.id]: { succeeded: false, rejected: Option.none() },
                [afterPartial.execution.attempt.id]: { succeeded: true, rejected: Option.none() },
              },
            );
          }),
        ),
    );
    it.live("records the comments an Attempt posted before it failed, on that Attempt", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("commented");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const started = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            "local",
            Option.none(),
          );
          assert(started._tag === "AttemptStarted");
          const review = Comment.make({
            url: new URL("https://github.com/basaltbytes/usine/pull/71#pullrequestreview-9"),
            kind: "review",
            at: Option.some(DateTime.makeUnsafe("2026-10-20T10:00:00.000Z")),
          });
          yield* store.recordComments(started.execution.attempt.id, [review]);
          yield* store.finishAttempt(
            started.execution.attempt,
            Result.fail(AgentFailure.make({ message: "Checks failed" })),
          );
          yield* store.retry(runId);
          const retried = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            "local",
            Option.none(),
          );
          assert(retried._tag === "AttemptStarted");

          const attempts = (yield* store.snapshot(runId)).attempts;
          assert.deepStrictEqual(attempts[0]?.comments, [review]);
          // An Attempt without recorded comments, like every Attempt from before they were stored, reads as empty.
          assert.deepStrictEqual(attempts[1]?.comments, []);
          assert(Option.isNone((yield* store.snapshot(runId)).step.result));
        }),
      ),
    );
    it.live(
      "adds up the processes the kernel killed in each of an Attempt's containers, on that Attempt",
      () =>
        withPersistence(
          adapter,
          Effect.gen(function* () {
            const store = yield* RunStore;
            const runId = RunId.make("out-of-memory");
            yield* store.recordAndClaim(lifecycleSubmission, runId);
            const started = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              "local",
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            const attemptId = started.execution.attempt.id;
            const killed = (container: string, kills: number, memoryMib: number) =>
              store.recordOutOfMemory(
                attemptId,
                ContainerOutOfMemoryKills.make({
                  container: ContainerId.make(container.repeat(64)),
                  kills,
                  processes: [
                    MemoryKilledProcess.make({ command: `worker-${container}`, pid: 1234 }),
                  ],
                  memoryMib: ContainerMemoryMib.make(memoryMib),
                }),
              );
            // A stopping orchestrator records the kills of the container it removes.
            yield* killed("a", 2, 4096);
            const reattached = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              "local",
              Option.some(attemptId),
            );
            assert(reattached._tag === "AttemptStarted");
            // The reattached Attempt runs in a new container, whose kills are recorded once more.
            yield* killed("b", 1, 7168);
            yield* killed("b", 1, 7168);
            yield* store.finishAttempt(
              reattached.execution.attempt,
              Result.fail(AgentFailure.make({ message: "The test gate was killed" })),
            );
            yield* store.retry(runId);
            const retried = yield* store.beginAttempt(
              runId,
              WorkerName.make("local"),
              "local",
              Option.none(),
            );
            assert(retried._tag === "AttemptStarted");

            const attempts = (yield* store.snapshot(runId)).attempts;
            assert.deepStrictEqual(
              attempts[0]?.outOfMemory,
              Option.some(
                OutOfMemoryKills.make({
                  kills: 3,
                  memoryMib: ContainerMemoryMib.make(7168),
                  processes: [
                    MemoryKilledProcess.make({ command: "worker-a", pid: 1234 }),
                    MemoryKilledProcess.make({ command: "worker-b", pid: 1234 }),
                  ],
                }),
              ),
            );
            assert.deepStrictEqual(attempts[1]?.outOfMemory, Option.none());
          }),
        ),
    );

    it.live("records the kind of the Worker each Attempt started on", () =>
      withPersistence(
        adapter,
        Effect.gen(function* () {
          const store = yield* RunStore;
          const runId = RunId.make("worker-kinds");
          const worker = WorkerName.make("remote");
          yield* store.recordAndClaim(lifecycleSubmission, runId);
          const first = yield* store.beginAttempt(runId, worker, "exe.dev", Option.none());
          assert(first._tag === "AttemptStarted");
          // A reattach keeps the kind recorded when the Attempt started.
          const reattached = yield* store.beginAttempt(
            runId,
            worker,
            "ssh",
            Option.some(first.execution.attempt.id),
          );
          assert(reattached._tag === "AttemptStarted");
          assert.deepStrictEqual(reattached.execution.attempt.workerKind, Option.some("exe.dev"));
          yield* store.finishAttempt(
            first.execution.attempt,
            Result.fail(InfraFailure.make({ message: "worker lost", cause: "test" })),
          );
          const second = yield* store.beginAttempt(runId, worker, "ssh", Option.none());
          assert(second._tag === "AttemptStarted");

          assert.deepStrictEqual(
            (yield* store.snapshot(runId)).attempts.map(({ workerKind }) => workerKind),
            [Option.some("exe.dev"), Option.some("ssh")],
          );
        }),
      ),
    );
  });
};
