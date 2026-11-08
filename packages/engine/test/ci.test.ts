import { jsonKey } from "@usine/core/json-key";
import { withRunStore } from "./store/support.ts";
import { assert, it } from "@effect/vitest";
import {
  CiFailed,
  CiHandedOff,
  CiLabelMutation,
  CiPassed,
  CiPolicy,
  CiSuperseded,
  CiTimedOut,
} from "@usine/core/ci";
import { WorkerName } from "@usine/core/worker";
import { BlockedFailure } from "@usine/core/attempt/failure";
import { ItemNumber } from "@usine/core/item";
import { CycleLimit } from "@usine/core/cycle-budget";
import * as RunState from "@usine/core/run/state";
import { CycleBudgets } from "../src/cycle-budget/cycle-budget.ts";
import { CommitSha } from "@usine/core/repository";
import { LoopName } from "@usine/core/loop";
import { PullRequest, StepResult } from "@usine/core/step/result";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Option,
  Ref,
  Schedule,
  Scope,
  Layer,
  TxRef,
} from "effect";
import { Event, type EventId } from "@usine/core/event";
import { RunEngine } from "../src/engine/engine.ts";
import { Submission } from "../src/engine/submission.ts";
import { RunStore } from "../src/store/store.ts";
import { localSqliteLayer } from "../src/database/local-sqlite.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";
import { RunId } from "@usine/core/run";
import { Result } from "effect";
import {
  approvalEvent,
  type AttemptPlan,
  conditionLayer,
  engineLayer,
  executorLayer,
  slottedExecutor,
  stepResult,
  stillMatches,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

const head = CommitSha.make("a".repeat(40));
const policy = CiPolicy.make({ fixLoop: LoopName.make("fix"), timeoutSeconds: 3600 });
const pushed = StepResult.make({
  message: "Finished the change.",
  facts: [
    PullRequest.make({
      number: 815,
      url: new URL("https://github.com/basaltbytes/usine/pull/815"),
      base: Option.some(CommitSha.make("0".repeat(40))),
      head: Option.some(head),
    }),
  ],
});
const required = () =>
  Submission.make({ ...submission({ number: 1 }), ciPolicy: Option.some(policy) });

it.live.each(["verified", "unverified"] as const)(
  "a %s CI handoff either waits or records a retryable infrastructure failure",
  (verification) =>
    withRunStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const runId = RunId.make("lagging-handoff");
        yield* store.recordAndClaim(required(), runId);
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(started._tag === "AttemptStarted");
        const result = StepResult.make({
          message: `[usine:awaiting-ci]\n${jsonKey({ pull_request: 815, head, fix_loop: "fix", timeout_seconds: 3600, on_green: [] })}`,
          facts: verification === "verified" ? pushed.facts : [],
        });
        const decision = yield* store.finishAttempt(
          started.execution.attempt,
          Result.succeed(result),
        );
        assert.strictEqual(
          decision._tag,
          verification === "verified" ? "RunAwaitingCi" : "RetryAttempt",
        );
        if (verification === "verified") {
          const snapshot = yield* store.snapshot(runId);
          assert(snapshot.run.state._tag === "AwaitingCi");
          assert.strictEqual(snapshot.run.state.handoff.head, head);
          return;
        }
        const snapshot = yield* store.snapshot(runId);
        const outcome = snapshot.attempts[0]?.outcome;
        assert(outcome !== undefined && Option.isSome(outcome) && outcome.value._tag === "Failed");
        assert.strictEqual(outcome.value.failure._tag, "InfraFailure");
      }),
    ),
);

it.live(
  "a required CI check survives an ordinary success report and restart while releasing its worker slot",
  () =>
    withInstance((directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* slottedExecutor([
            Effect.succeed(pushed),
            Effect.succeed(stepResult("other item")),
          ]);
          const runtime = engineLayer(directory, worker.executor);
          const firstScope = yield* Scope.make();
          const services = yield* Scope.provide(Layer.build(runtime), firstScope);
          const first = Context.get(services, RunEngine);
          const ciOnGreen = [
            CiLabelMutation.make({
              item: ItemNumber.make(811),
              add: ["implemented"],
              remove: ["agent-in-progress"],
            }),
          ];
          const accepted = yield* first.submit(Submission.make({ ...required(), ciOnGreen }));
          assert(accepted._tag === "Claimed");
          const waiting = yield* waitFor(
            first,
            accepted.runId,
            ({ run }) => run.state._tag === "AwaitingCi",
          );
          assert(waiting.run.state._tag === "AwaitingCi");
          assert.deepStrictEqual(waiting.run.state.handoff.onGreen, ciOnGreen);
          assert.strictEqual(
            waiting.attempts
              .at(-1)
              ?.outcome.pipe(Option.map(({ _tag }) => _tag))
              .pipe(Option.getOrNull),
            "AwaitingCi",
          );
          const other = yield* first.submit(submission({ number: 2, item: "other" }));
          assert(other._tag === "Claimed");
          yield* waitFor(first, other.runId, ({ run }) => run.state._tag === "Succeeded");
          yield* first.drain;
          const leasedState = yield* TxRef.get(worker.leased);
          assert.strictEqual(leasedState, 0);
          yield* Scope.close(firstScope, Exit.void);
          const secondScope = yield* Scope.make();
          const currentServices = yield* Scope.provide(Layer.build(runtime), secondScope);
          const second = Context.get(currentServices, RunEngine);
          const waits = yield* second.awaitingCi;
          assert.strictEqual(waits.length, 1);
          const restored = waits[0];
          assert(restored?.run.state._tag === "AwaitingCi");
          assert.deepStrictEqual(restored.run.state.handoff.onGreen, ciOnGreen);
          assert.strictEqual(
            (yield* second.inspect(accepted.runId)).ciPolicy.pipe(
              Option.map(({ fixLoop }) => fixLoop),
              Option.getOrNull,
            ),
            policy.fixLoop,
          );
          yield* second.reconcile;
          yield* second.settleCi(accepted.runId, head, CiPassed.make());
          yield* second.settleCi(accepted.runId, head, CiFailed.make({ message: "late red" }));
          const completed = yield* second.inspect(accepted.runId);
          assert.strictEqual(completed.run.state._tag, "Succeeded");
          assert.strictEqual(completed.attempts.length, 1);
          assert.deepStrictEqual(completed.attempts[0]?.endedAt, waiting.attempts[0]?.endedAt);
          assert.strictEqual((yield* second.awaitingCi).length, 0);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
    ),
);

it.live.each([
  CiSuperseded.make({ head: CommitSha.make("b".repeat(40)) }),
  CiFailed.make({ message: "CI failed without an available fix loop" }),
  CiTimedOut.make({ message: "CI is still running after its deadline" }),
])("CI settlement preserves the result's producing attempt after $_tag", (resolution) =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const worker = yield* slottedExecutor([Effect.succeed(pushed), Effect.never]);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(required());
        assert(accepted._tag === "Claimed");
        const waiting = yield* waitFor(
          engine,
          accepted.runId,
          ({ run }) => run.state._tag === "AwaitingCi",
        );
        assert.deepStrictEqual(
          Option.flatMap(waiting.step.result, ({ attemptId }) => attemptId),
          Option.fromNullishOr(waiting.attempts[0]?.id),
        );
        yield* engine.settleCi(accepted.runId, head, resolution);
        yield* engine.settleCi(accepted.runId, head, CiPassed.make());
        const settled = yield* engine.inspect(accepted.runId);
        assert.strictEqual(
          settled.run.state._tag,
          resolution._tag === "CiSuperseded" ? "Canceled" : "Failed",
        );
        assert.deepStrictEqual(settled.step.result, waiting.step.result);
        if (resolution._tag === "CiTimedOut") {
          const outcome = Option.getOrNull(settled.attempts[0]?.outcome ?? Option.none());
          assert(outcome?._tag === "Failed");
          assert.strictEqual(outcome.failure._tag, "InfraFailure");
          assert.strictEqual(outcome.failure.message, resolution.message);
        }
        if (resolution._tag === "CiFailed") {
          yield* engine.retry(accepted.runId);
          const retrying = yield* waitFor(
            engine,
            accepted.runId,
            ({ attempts }) => attempts.length === 2,
          );
          assert.deepStrictEqual(retrying.step.result, waiting.step.result);
          yield* engine.cancel(accepted.runId);
        }
      }).pipe(Effect.provide(engineLayer(directory, worker.executor)));
    }),
  ),
);

it.live("a successful retry preserves both attempts' harvested ranges across restart", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const nextHead = CommitSha.make("b".repeat(40));
      const next = StepResult.make({
        message: "Retry pushed a fix",
        facts: [
          PullRequest.make({
            number: 815,
            url: new URL("https://github.com/basaltbytes/usine/pull/815"),
            base: Option.some(head),
            head: Option.some(nextHead),
          }),
        ],
      });
      const worker = yield* slottedExecutor([Effect.succeed(pushed), Effect.succeed(next)]);
      const runtime = engineLayer(directory, worker.executor);
      const runId = yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(required());
          assert(accepted._tag === "Claimed");
          const waiting = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "AwaitingCi",
          );
          yield* engine.settleCi(accepted.runId, head, CiFailed.make({ message: "CI failed" }));
          yield* engine.retry(accepted.runId);
          yield* waitFor(engine, accepted.runId, ({ run }) => run.state._tag === "AwaitingCi");
          yield* engine.settleCi(accepted.runId, nextHead, CiPassed.make());
          const completed = yield* engine.inspect(accepted.runId);
          assert.strictEqual(completed.run.state._tag, "Succeeded");
          assert.strictEqual(completed.attempts.length, 2);
          assert.deepStrictEqual(completed.attempts[0]?.result, waiting.step.result);
          assert.deepStrictEqual(completed.attempts[1]?.result, completed.step.result);
          return accepted.runId;
        }).pipe(Effect.provide(runtime)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* RunEngine;
          const restored = yield* engine.inspect(runId);
          assert.deepStrictEqual(
            restored.attempts.map((attempt) => Option.map(attempt.result, ({ facts }) => facts)),
            [Option.some(pushed.facts), Option.some(next.facts)],
          );
        }).pipe(Effect.provide(runtime)),
      );
    }),
  ),
);

it.live("a required CI loop fails a success report without a pushed PR", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const worker = yield* slottedExecutor([Effect.succeed(stepResult("Done"))]);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(required());
        assert(accepted._tag === "Claimed");
        const failed = yield* waitFor(
          engine,
          accepted.runId,
          ({ run }) => run.state._tag === "Failed",
        );
        assert.strictEqual(failed.attempts.length, 1);
      }).pipe(Effect.provide(engineLayer(directory, worker.executor)));
    }),
  ),
);

it.live("operator cancellation settles the ended CI attempt and rejects late completion", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const worker = yield* slottedExecutor([Effect.succeed(pushed)]);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(required());
        assert(accepted._tag === "Claimed");
        const waiting = yield* waitFor(
          engine,
          accepted.runId,
          ({ run }) => run.state._tag === "AwaitingCi",
        );
        yield* engine.cancel(accepted.runId);
        yield* engine.settleCi(accepted.runId, head, CiPassed.make());
        const canceled = yield* engine.inspect(accepted.runId);
        assert.strictEqual(canceled.run.state._tag, "Canceled");
        assert.strictEqual(
          canceled.attempts[0]?.outcome.pipe(
            Option.map(({ _tag }) => _tag),
            Option.getOrNull,
          ),
          "Canceled",
        );
        assert.deepStrictEqual(canceled.attempts[0]?.endedAt, waiting.attempts[0]?.endedAt);
      }).pipe(Effect.provide(engineLayer(directory, worker.executor)));
    }),
  ),
);

it.live.each([1, 2])(
  "a same-loop CI fix settles the source neutrally only when admitted with a cycle limit of %s",
  (limit) =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const worker = yield* slottedExecutor([
          Effect.succeed(pushed),
          Effect.succeed(stepResult("Fixed")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const source = Submission.make({
            ...required(),
            loop: policy.fixLoop,
            cycleLimit: Option.some(CycleLimit.make(limit)),
          });
          const accepted = yield* engine.submit(source);
          assert(accepted._tag === "Claimed");
          const waiting = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "AwaitingCi",
          );
          const fix = yield* engine.submit(
            Submission.make({
              ...submission({ number: 2 }),
              loop: policy.fixLoop,
              cycleLimit: source.cycleLimit,
              ciFailureHead: Option.some(head),
            }),
          );
          assert.strictEqual(fix._tag, limit === 1 ? "CycleBlocked" : "Claimed");
          const reason = "CI failed: ci.";
          yield* engine.settleCi(
            accepted.runId,
            head,
            fix._tag === "Claimed"
              ? CiHandedOff.make({ reason, fixRunId: fix.runId })
              : CiFailed.make({ message: reason }),
          );
          const settled = yield* engine.inspect(accepted.runId);
          assert.deepStrictEqual(settled.attempts[0]?.endedAt, waiting.attempts[0]?.endedAt);
          assert(Option.isSome(settled.closedAt));
          if (fix._tag === "Claimed") {
            assert.deepStrictEqual(
              settled.run.state,
              RunState.HandedOff.make({
                reason,
                fixRunId: fix.runId,
                head,
                fixLoop: policy.fixLoop,
              }),
            );
            assert.strictEqual(
              RunState.operatorActions(settled.run.state).canResolveFailure,
              false,
            );
            assert.strictEqual(
              Option.getOrNull(settled.attempts[0]?.outcome ?? Option.none())?._tag,
              "HandedOff",
            );
            yield* engine.settleCi(
              accepted.runId,
              head,
              CiFailed.make({ message: "late observation" }),
            );
            assert.strictEqual((yield* engine.inspect(accepted.runId)).run.state._tag, "HandedOff");
            yield* waitFor(engine, fix.runId, ({ run }) => run.state._tag === "Succeeded");
          } else {
            assert.strictEqual(settled.run.state._tag, "Failed");
            assert.strictEqual(RunState.operatorActions(settled.run.state).canResolveFailure, true);
            assert.strictEqual((yield* (yield* CycleBudgets).asks).length, 1);
          }
        }).pipe(Effect.provide(engineLayer(directory, worker.executor)));
      }),
    ),
);

it.live(
  "a reset preserves only the blocked CI fix across restart, including revoked events and inherited actions",
  () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const actions = [
          CiLabelMutation.make({
            item: ItemNumber.make(811),
            add: ["implemented"],
            remove: ["agent-in-progress"],
          }),
        ];
        const source = Submission.make({
          ...submission({ number: 1 }),
          cycleLimit: Option.some(CycleLimit.make(1)),
        });
        const current = Submission.make({
          ...submission({ number: 4 }),
          loop: policy.fixLoop,
          ciFailureHead: Option.some(head),
          ciOnGreen: actions,
          ciPolicy: Option.some(policy),
        });
        const storage = Layer.merge(RunStore.layer, CycleBudgets.layer).pipe(
          Layer.provide(localSqliteLayer(directory)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* RunStore;
            const budgets = yield* CycleBudgets;
            const sourceId = RunId.make("source");
            yield* store.recordAndClaim(source, sourceId);
            const started = yield* store.beginAttempt(
              sourceId,
              WorkerName.make("local"),
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            yield* store.finishAttempt(
              started.execution.attempt,
              Result.succeed(stepResult("Completed")),
            );
            const labelEvent = Submission.make({
              ...submission({ number: 2 }),
              cycleLimit: source.cycleLimit,
            });
            const exhausted = yield* store.recordAndClaim(labelEvent, RunId.make("exhausted"));
            assert(exhausted.result._tag === "CycleBlocked");
            const older = Submission.make({ ...current, event: submission({ number: 3 }).event });
            yield* store.recordAndClaim(older, RunId.make("older-ci-fix"));
            const blocked = yield* store.recordAndClaim(current, RunId.make("current-ci-fix"));
            assert(blocked.result._tag === "CycleBlocked");
            const waitingForReset = yield* store.pendingCiFixes;
            assert.deepStrictEqual(waitingForReset, []);
            yield* store.revoke(current.loop, current.itemKey);
            const answer = approvalEvent(1);
            const replayed = yield* budgets.reset(blocked.result.ask.id, answer);
            assert.deepStrictEqual(replayed, [current.event.id]);
            const repeated = yield* budgets.reset(blocked.result.ask.id, answer);
            assert.deepStrictEqual(repeated, []);
            const pending = yield* store.pendingCiFixes;
            assert.strictEqual(pending.length, 1);
            assert.strictEqual(pending[0]?.submission.event.id, current.event.id);
            assert.strictEqual(pending[0]?.submission.cycleGeneration, 1);
            const stale = yield* store.recordAndClaim(labelEvent, RunId.make("stale-label-event"));
            assert.strictEqual(stale.result._tag, "Ignored");
          }).pipe(Effect.provide(storage)),
        );

        const worker = yield* slottedExecutor([Effect.succeed(pushed)]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* RunEngine;
            const reader = yield* RunReader;
            const admitted = yield* reader.runForEvent(current.event.dedupKey);
            assert(Option.isSome(admitted));
            const waiting = yield* waitFor(
              engine,
              admitted.value,
              ({ run }) => run.state._tag === "AwaitingCi",
            );
            assert(waiting.run.state._tag === "AwaitingCi");
            assert.deepStrictEqual(waiting.run.state.handoff.onGreen, actions);
            assert.strictEqual(waiting.attempts.length, 1);
            yield* engine.reconcile;
            const repeated = yield* engine.inspect(admitted.value);
            assert.strictEqual(repeated.attempts.length, 1);
            yield* engine.drain;
          }).pipe(Effect.provide(engineLayer(directory, worker.executor))),
        );
      }),
    ),
);

it.live.each(["required", "none"] as const)(
  "item revocation cancels unstarted CI fixes with %s approval",
  (approval) =>
    withInstance((directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* RunStore;
          const current = Submission.make({
            ...submission({ number: 1, approval }),
            ciFailureHead: Option.some(head),
          });
          const runId = RunId.make("unstarted-ci-fix");
          yield* store.recordAndClaim(current, runId);
          if (approval === "required") yield* store.parkForApproval(runId);
          const labelRevoked = yield* store.revoke(current.loop, current.itemKey, {
            openCiHead: head,
          });
          assert.deepStrictEqual(labelRevoked, []);
          assert.strictEqual(
            (yield* store.snapshot(runId)).run.state._tag,
            approval === "required" ? "Waiting" : "Pending",
          );

          const itemRevoked = yield* store.revoke(current.loop, current.itemKey);
          assert.deepStrictEqual(itemRevoked, [runId]);
          const revoked = yield* store.snapshot(runId);
          assert(revoked.run.state._tag === "Canceled");
          assert.strictEqual(revoked.run.state.reason._tag, "Revoked");
          assert.deepStrictEqual(revoked.attempts, []);
          const pending = yield* store.pendingCiFixes;
          assert.deepStrictEqual(pending, []);
        }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provide(localSqliteLayer(directory))))),
      ),
    ),
);

it.live(
  "reconciliation preserves the latest cycle ask block when CI and label events compete",
  () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const worker = yield* slottedExecutor([Effect.succeed(stepResult("Completed"))]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* RunEngine;
            const budgets = yield* CycleBudgets;
            const source = Submission.make({
              ...submission({ number: 1 }),
              cycleLimit: Option.some(CycleLimit.make(1)),
            });
            const accepted = yield* engine.submit(source);
            assert(accepted._tag === "Claimed");
            yield* waitFor(engine, accepted.runId, ({ run }) => run.state._tag === "Succeeded");
            const ci = Submission.make({
              ...source,
              event: submission({ number: 2 }).event,
              ciFailureHead: Option.some(head),
            });
            assert.strictEqual((yield* engine.submit(ci))._tag, "CycleBlocked");
            const label = Submission.make({ ...source, event: submission({ number: 3 }).event });
            assert.strictEqual((yield* engine.submit(label))._tag, "CycleBlocked");
            const before = yield* budgets.asks;
            assert.strictEqual(before[0]?.blocks[0]?.eventId, label.event.id);
            yield* engine.reconcile;
            yield* engine.reconcile;
            const after = yield* budgets.asks;
            assert.deepStrictEqual(after, before);
          }).pipe(Effect.provide(engineLayer(directory, worker.executor))),
        );
      }),
    ),
);

it.live("a suppressed CI fix stays queued until the operator resolves the blocker", () =>
  withInstance((directory) =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* RunStore;
        const current = submission({ number: 1 });
        const runId = RunId.make("blocked-ci-fix");
        yield* store.recordAndClaim(current, runId);
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(started._tag === "AttemptStarted");
        yield* store.finishAttempt(
          started.execution.attempt,
          Result.fail(BlockedFailure.make({ message: "Needs an operator decision" })),
        );
        const queued = Submission.make({
          ...current,
          event: submission({ number: 2 }).event,
          ciFailureHead: Option.some(head),
        });
        const blocked = yield* store.recordAndClaim(queued, RunId.make("queued-ci-fix"));
        assert.strictEqual(blocked.result._tag, "Suppressed");
        const suppressed = yield* store.pendingCiFixes;
        assert.deepStrictEqual(suppressed, []);
        yield* store.resolveFailure(runId, started.execution.attempt.id, Option.none());
        assert.strictEqual((yield* store.pendingCiFixes)[0]?.submission.event.id, queued.event.id);
      }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provide(localSqliteLayer(directory))))),
    ),
  ),
);

it.live("a CI fix queued behind a running attempt is not rechecked until the attempt ends", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const rechecks = yield* Ref.make<ReadonlyArray<EventId>>([]);
      const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
        Deferred.await(finish).pipe(Effect.as(stepResult("first"))),
        Effect.succeed(stepResult("fixed")),
      ]);
      const condition = conditionLayer((queued) =>
        Ref.update(rechecks, (all) => [...all, queued.event.id]).pipe(
          Effect.andThen(stillMatches(queued)),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const engine = yield* RunEngine;
          const running = yield* engine.submit(submission({ number: 1 }));
          assert(running._tag === "Claimed");
          yield* waitFor(engine, running.runId, ({ run }) => run.state._tag === "Running");
          const fix = Submission.make({
            ...submission({ number: 2 }),
            ciFailureHead: Option.some(head),
          });
          const queued = yield* engine.submit(fix);
          assert.strictEqual(queued._tag, "Queued");

          yield* engine.reconcile;

          const behindRunning = yield* Ref.get(rechecks);
          assert.deepStrictEqual(behindRunning, []);
          yield* Deferred.succeed(finish, undefined);
          const reader = yield* RunReader;
          const opened = yield* reader.runForEvent(fix.event.dedupKey).pipe(
            Effect.repeat({
              until: Option.isSome,
              schedule: Schedule.spaced("10 millis"),
              times: 500,
            }),
          );
          assert(Option.isSome(opened));
          const afterClose = yield* Ref.get(rechecks);
          assert.deepStrictEqual(afterClose, [fix.event.id]);
          yield* engine.drain;
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans), condition))),
      );
    }),
  ),
);

it.live.each([
  { newest: "CI fix", sameTime: false },
  { newest: "trigger match", sameTime: false },
  { newest: "CI fix", sameTime: true },
  { newest: "trigger match", sameTime: true },
] as const)(
  "the newest queued Event opens the next Run when it is a $newest (equal receive times: $sameTime)",
  ({ newest, sameTime }) =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const storage = RunStore.layer.pipe(Layer.provide(localSqliteLayer(directory)));
        const ciFix = (number: number) =>
          Submission.make({ ...submission({ number }), ciFailureHead: Option.some(head) });
        const older = newest === "CI fix" ? submission({ number: 2 }) : ciFix(2);
        const candidate = newest === "CI fix" ? ciFix(3) : submission({ number: 3 });
        const newer = Submission.make({
          ...candidate,
          event: Event.make({
            ...candidate.event,
            receivedAt: sameTime ? older.event.receivedAt : candidate.event.receivedAt,
          }),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* RunStore;
            const sourceId = RunId.make("closed-source");
            yield* store.recordAndClaim(submission({ number: 1 }), sourceId);
            const started = yield* store.beginAttempt(
              sourceId,
              WorkerName.make("local"),
              Option.none(),
            );
            assert(started._tag === "AttemptStarted");
            const ordered = sameTime ? [newer, older] : [older, newer];
            yield* Effect.forEach(ordered, (queued) =>
              store
                .recordAndClaim(queued, RunId.make(queued.event.id))
                .pipe(
                  Effect.tap((claim) =>
                    Effect.sync(() => assert.strictEqual(claim.result._tag, "Queued")),
                  ),
                ),
            );
            const whileRunning = yield* store.pendingCiFixes;
            assert.deepStrictEqual(whileRunning, []);
            yield* store.finishAttempt(
              started.execution.attempt,
              Result.succeed(stepResult("first")),
            );

            const fixes = yield* store.pendingCiFixes;
            const continuations = yield* store.pendingContinuations;
            const next = yield* store.nextQueued(sourceId);
            assert(Option.isSome(next));
            assert.strictEqual(next.value.submission.event.id, newer.event.id);
            assert.deepStrictEqual(next.value.eventIds, [newer.event.id, older.event.id]);

            if (newest === "CI fix") {
              assert.deepStrictEqual(
                fixes.map(({ submission, eventIds }) => [submission.event.id, eventIds]),
                [[newer.event.id, [newer.event.id, older.event.id]]],
              );
              assert.deepStrictEqual(continuations, []);
            } else {
              assert.deepStrictEqual(fixes, []);
              assert.deepStrictEqual(continuations, [sourceId]);
            }
          }).pipe(Effect.provide(storage)),
        );

        const rechecks = yield* Ref.make<ReadonlyArray<EventId>>([]);
        const condition = conditionLayer((queued) =>
          Ref.update(rechecks, (all) => [...all, queued.event.id]).pipe(
            Effect.andThen(stillMatches(queued)),
          ),
        );
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("newest")),
        ]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const engine = yield* RunEngine;
            const reader = yield* RunReader;
            const opened = yield* reader.runForEvent(newer.event.dedupKey);
            assert(Option.isSome(opened));
            yield* waitFor(engine, opened.value, ({ run }) => run.state._tag === "Succeeded");
            const superseded = yield* reader.runForEvent(older.event.dedupKey);
            assert(Option.isNone(superseded));
            const checked = yield* Ref.get(rechecks);
            assert.deepStrictEqual(checked, [newer.event.id]);
            yield* engine.drain;
          }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans), condition))),
        );
      }),
    ),
);
