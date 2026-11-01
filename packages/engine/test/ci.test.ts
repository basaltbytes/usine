import { assert, it } from "@effect/vitest";
import { CiFailed, CiPassed, CiPolicy, CiSuperseded } from "@usine/core/ci";
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
const policy = new CiPolicy({ fixLoop: LoopName.make("fix"), timeoutSeconds: 3600 });
const pushed = new StepResult({
  message: "Finished the change.",
  facts: [
    new PullRequest({
      number: 815,
      url: new URL("https://github.com/basaltbytes/usine/pull/815"),
      head: Option.some(head),
    }),
  ],
});
const required = () =>
  new Submission({ ...submission({ number: 1 }), ciPolicy: Option.some(policy) });

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
          const first = Context.get(
            yield* Scope.provide(Layer.build(runtime), firstScope),
            RunEngine,
          );
          const accepted = yield* first.submit(required());
          assert(accepted._tag === "Claimed");
          const waiting = yield* waitFor(
            first,
            accepted.runId,
            ({ run }) => run.state._tag === "AwaitingCi",
          );
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
          yield* first.drain();
          assert.strictEqual(yield* TxRef.get(worker.leased), 0);
          yield* Scope.close(firstScope, Exit.void);
          const secondScope = yield* Scope.make();
          const second = Context.get(
            yield* Scope.provide(Layer.build(runtime), secondScope),
            RunEngine,
          );
          assert.strictEqual((yield* second.awaitingCi()).length, 1);
          assert.strictEqual(
            (yield* second.inspect(accepted.runId)).ciPolicy
              .pipe(Option.map(({ fixLoop }) => fixLoop))
              .pipe(Option.getOrNull),
            policy.fixLoop,
          );
          yield* second.reconcile();
          yield* second.settleCi(accepted.runId, head, new CiPassed());
          yield* second.settleCi(accepted.runId, head, new CiFailed({ message: "late red" }));
          const completed = yield* second.inspect(accepted.runId);
          assert.strictEqual(completed.run.state._tag, "Succeeded");
          assert.strictEqual(completed.attempts.length, 1);
          assert.deepStrictEqual(completed.attempts[0]?.endedAt, waiting.attempts[0]?.endedAt);
          assert.strictEqual((yield* second.awaitingCi()).length, 0);
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
    ),
);

it.live("a newer head cancels its CI wait and rejects a late green result", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const worker = yield* slottedExecutor([Effect.succeed(pushed)]);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(required());
        assert(accepted._tag === "Claimed");
        yield* waitFor(engine, accepted.runId, ({ run }) => run.state._tag === "AwaitingCi");
        yield* engine.settleCi(
          accepted.runId,
          head,
          new CiSuperseded({ head: CommitSha.make("b".repeat(40)) }),
        );
        yield* engine.settleCi(accepted.runId, head, new CiPassed());
        assert.strictEqual((yield* engine.inspect(accepted.runId)).run.state._tag, "Canceled");
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
        yield* engine.settleCi(accepted.runId, head, new CiPassed());
        const canceled = yield* engine.inspect(accepted.runId);
        assert.strictEqual(canceled.run.state._tag, "Canceled");
        assert.strictEqual(
          canceled.attempts[0]?.outcome.pipe(Option.map(({ _tag }) => _tag)).pipe(Option.getOrNull),
          "Canceled",
        );
        assert.deepStrictEqual(canceled.attempts[0]?.endedAt, waiting.attempts[0]?.endedAt);
      }).pipe(Effect.provide(engineLayer(directory, worker.executor)));
    }),
  ),
);
