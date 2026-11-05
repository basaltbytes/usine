import { assert, it } from "@effect/vitest";
import {
  CiFailed,
  CiHandedOff,
  CiLabelMutation,
  CiPassed,
  CiPolicy,
  CiSuperseded,
} from "@usine/core/ci";
import { ItemNumber } from "@usine/core/item";
import { CycleLimit } from "@usine/core/cycle-budget";
import * as RunState from "@usine/core/run/state";
import { CycleBudgets } from "../src/cycle-budget/cycle-budget.ts";
import { CommitSha } from "@usine/core/repository";
import { LoopName } from "@usine/core/loop";
import { PullRequest, StepResult } from "@usine/core/step/result";
import { Context, Effect, Exit, Option, Scope, Layer, TxRef } from "effect";
import { RunEngine } from "../src/engine/engine.ts";
import { Submission } from "../src/engine/submission.ts";
import {
  engineLayer,
  slottedExecutor,
  stepResult,
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
      head: Option.some(head),
    }),
  ],
});
const required = () =>
  Submission.make({ ...submission({ number: 1 }), ciPolicy: Option.some(policy) });

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
