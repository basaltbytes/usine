import { assert, describe, it } from "@effect/vitest";
import { AgentFailure } from "@usine/core/attempt/failure";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { Deferred, Effect, Option, Ref } from "effect";
import { RunEngine } from "../src/engine/engine.ts";
import { runIdFor } from "../src/engine/submission.ts";
import {
  type AttemptPlan,
  engineLayer,
  executorLayer,
  stepResult,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

const loop = LoopName.make("review");

describe("Events of canceled Runs", () => {
  it.live("opens a new Run when the Item comes back to the state of a canceled Run", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const item = ItemKey.make("canceled-item");
          const sighting = submission({ number: 1, item: "canceled-item", approval: "required" });
          const first = yield* engine.submit(sighting);
          assert(first._tag === "Claimed");
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Waiting");
          yield* engine.cancel(first.runId);

          // The Item hasn't changed since the cancel, so the Run stays canceled.
          const unchanged = yield* engine.submit(sighting);
          assert(unchanged._tag === "Claimed");
          assert.strictEqual(unchanged.runId, first.runId);

          // The operator removes the label and adds it again.
          yield* engine.revoke(loop, item);
          const relabeled = yield* engine.submit(sighting);
          assert(relabeled._tag === "Claimed");
          assert.notStrictEqual(relabeled.runId, first.runId);
          yield* waitFor(engine, relabeled.runId, ({ run }) => run.state._tag === "Waiting");
          assert.strictEqual((yield* engine.inspect(first.runId)).run.state._tag, "Canceled");

          const again = yield* engine.submit(sighting);
          assert(again._tag === "Claimed");
          assert.strictEqual(again.runId, relabeled.runId);
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("opens a new Run for an Event whose Run was revoked or superseded", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const item = ItemKey.make("unstarted-item");
          const older = submission({ number: 2, item: "unstarted-item", approval: "required" });
          const newer = submission({ number: 3, item: "unstarted-item", approval: "required" });

          const revoked = yield* engine.submit(older);
          assert(revoked._tag === "Claimed");
          yield* waitFor(engine, revoked.runId, ({ run }) => run.state._tag === "Waiting");
          yield* engine.revoke(loop, item);
          const returned = yield* engine.submit(older);
          assert(returned._tag === "Claimed");
          assert.notStrictEqual(returned.runId, revoked.runId);
          yield* waitFor(engine, returned.runId, ({ run }) => run.state._tag === "Waiting");

          const superseding = yield* engine.submit(newer);
          assert(superseding._tag === "Claimed");
          const superseded = yield* engine.inspect(returned.runId);
          assert(
            superseded.run.state._tag === "Canceled" &&
              superseded.run.state.reason._tag === "Superseded",
          );
          // The Item goes back to the older state, which supersedes the newer Run in turn.
          const reverted = yield* engine.submit(older);
          assert(reverted._tag === "Claimed");
          assert.notStrictEqual(reverted.runId, returned.runId);
          assert.notStrictEqual(reverted.runId, revoked.runId);
          const replaced = yield* engine.inspect(superseding.runId);
          assert(
            replaced.run.state._tag === "Canceled" &&
              replaced.run.state.reason._tag === "Superseded",
          );
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("opens a queued Event that a revoke ignored once the Item comes back to it", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(gate).pipe(Effect.as(stepResult("first result"))),
          Effect.succeed(stepResult("returned result")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const running = yield* engine.submit(submission({ number: 5, item: "revoked-queue" }));
          assert(running._tag === "Claimed");
          yield* waitFor(
            engine,
            running.runId,
            ({ run, attempts }) => run.state._tag === "Running" && attempts.length === 1,
          );
          const queued = submission({ number: 6, item: "revoked-queue" });
          assert.strictEqual((yield* engine.submit(queued))._tag, "Queued");
          yield* engine.revoke(loop, ItemKey.make("revoked-queue"));
          assert.strictEqual((yield* engine.submit(queued))._tag, "Queued");
          yield* Deferred.succeed(gate, undefined);
          yield* waitFor(engine, running.runId, ({ run }) => run.state._tag === "Succeeded");
          const reopened = yield* engine.submit(queued);
          assert(reopened._tag === "Claimed");
          assert.notStrictEqual(reopened.runId, yield* runIdFor(queued));
          const finished = yield* waitFor(
            engine,
            reopened.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert(Option.isSome(finished.step.result));
          assert.strictEqual(finished.step.result.value.message, "returned result");
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("keeps the Event of a failed Run for operator retry after the Item comes back", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.fail(new AgentFailure({ message: "Needs the operator" })),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const sighting = submission({ number: 4, item: "failed-item" });
          const failed = yield* engine.submit(sighting);
          assert(failed._tag === "Claimed");
          yield* waitFor(engine, failed.runId, ({ run }) => run.state._tag === "Failed");
          yield* engine.revoke(loop, ItemKey.make("failed-item"));
          const returned = yield* engine.submit(sighting);
          assert(returned._tag === "Claimed");
          assert.strictEqual(returned.runId, failed.runId);
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );
});
