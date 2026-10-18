import { assert, describe, it } from "@effect/vitest";
import { QuestionFailure } from "@usine/core/attempt/failure";
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

const question = new QuestionFailure({
  question: "Should the egress transport be HTTP CONNECT or a SOCKS proxy?",
});

/** Whether no Run exists yet for the submission's Event. */
const hasNoRun = (engine: RunEngine["Service"], sighting: ReturnType<typeof submission>) =>
  Effect.gen(function* () {
    const missing = yield* Effect.flip(engine.inspect(yield* runIdFor(sighting)));
    return missing._tag === "RunNotFoundError";
  });

describe("Attempts that end with an operator question", () => {
  it.live("holds the Item after a question until its content changes again", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          question,
          Effect.succeed(stepResult("worked from the pushed fix")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const asked = yield* engine.submit(submission({ number: 1, item: "asking-item" }));
          assert(asked._tag === "Claimed");
          const failed = yield* waitFor(
            engine,
            asked.runId,
            ({ run }) => run.state._tag === "Failed",
          );
          const outcome = failed.attempts[0]?.outcome;
          assert(outcome !== undefined && Option.isSome(outcome));
          assert(outcome.value._tag === "Failed");
          assert.deepStrictEqual(outcome.value.failure, question);

          // The Agent posted its question, so the Item's content changed under the same head.
          const posted = submission({ number: 2, item: "asking-item" });
          for (let poll = 0; poll < 3; poll += 1) {
            const held = yield* engine.submit(posted);
            assert(held._tag === "Held");
            assert.strictEqual(held.runId, asked.runId);
          }
          assert(yield* hasNoRun(engine, posted));

          // The operator pushes a fix, a change the question did not make.
          const fixed = submission({ number: 3, item: "asking-item" });
          const opened = yield* engine.submit(fixed);
          assert(opened._tag === "Claimed");
          yield* waitFor(engine, opened.runId, ({ run }) => run.state._tag === "Succeeded");
          assert.strictEqual((yield* engine.inspect(asked.runId)).run.state._tag, "Failed");
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("does not open the Event the question queued while its Attempt ran", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const asking = yield* Deferred.make<void>();
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(asking).pipe(Effect.andThen(question)),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const asked = yield* engine.submit(submission({ number: 4, item: "queued-question" }));
          assert(asked._tag === "Claimed");
          yield* waitFor(
            engine,
            asked.runId,
            ({ run, attempts }) => run.state._tag === "Running" && attempts.length === 1,
          );
          const posted = submission({ number: 5, item: "queued-question" });
          assert.strictEqual((yield* engine.submit(posted))._tag, "Queued");
          yield* Deferred.succeed(asking, undefined);
          yield* waitFor(engine, asked.runId, ({ run }) => run.state._tag === "Failed");
          yield* engine.reconcile();
          assert(yield* hasNoRun(engine, posted));
          // Polling sees the question's own comment again: it is the state the question holds.
          assert.strictEqual((yield* engine.submit(posted))._tag, "Held");
          assert(yield* hasNoRun(engine, posted));
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("evaluates the Item again once the operator resolves the question", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          question,
          Effect.succeed(stepResult("decided by the operator")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const asked = yield* engine.submit(submission({ number: 6, item: "resolved-question" }));
          assert(asked._tag === "Claimed");
          const failed = yield* waitFor(
            engine,
            asked.runId,
            ({ run }) => run.state._tag === "Failed",
          );
          const posted = submission({ number: 7, item: "resolved-question" });
          assert.strictEqual((yield* engine.submit(posted))._tag, "Held");
          const attempt = failed.attempts[0];
          assert(attempt !== undefined);
          yield* engine.resolveFailure(asked.runId, attempt.id);
          yield* waitFor(
            engine,
            yield* runIdFor(posted),
            ({ run }) => run.state._tag === "Succeeded",
          );
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("stops holding the Item once the Loop sees it not matching", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          question,
          Effect.succeed(stepResult("relabeled by the operator")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const asked = yield* engine.submit(submission({ number: 8, item: "relabeled-question" }));
          assert(asked._tag === "Claimed");
          yield* waitFor(engine, asked.runId, ({ run }) => run.state._tag === "Failed");
          const posted = submission({ number: 9, item: "relabeled-question" });
          assert.strictEqual((yield* engine.submit(posted))._tag, "Held");
          // The operator removes the Loop's label and adds it again.
          yield* engine.revoke(LoopName.make("review"), ItemKey.make("relabeled-question"));
          const relabeled = yield* engine.submit(posted);
          assert(relabeled._tag === "Claimed");
          yield* waitFor(engine, relabeled.runId, ({ run }) => run.state._tag === "Succeeded");
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );
});
