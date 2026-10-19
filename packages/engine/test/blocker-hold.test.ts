import { assert, describe, it } from "@effect/vitest";
import { AgentFailure, BlockedFailure } from "@usine/core/attempt/failure";
import { Effect, Option, Ref } from "effect";
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

const blocker = new BlockedFailure({
  message: "The baseline gate fails on main before any change. Fixing it needs a maintainer.",
});

/** Whether no Run exists yet for the submission's Event. */
const hasNoRun = (engine: RunEngine["Service"], sighting: ReturnType<typeof submission>) =>
  Effect.gen(function* () {
    const missing = yield* Effect.flip(engine.inspect(yield* runIdFor(sighting)));
    return missing._tag === "RunNotFoundError";
  });

describe("Attempts that end with a blocker", () => {
  it.live("holds the Item after a blocker until its content changes again", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          blocker,
          Effect.succeed(stepResult("worked from the maintainer's fix")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const blocked = yield* engine.submit(submission({ number: 1, item: "blocked-item" }));
          assert(blocked._tag === "Claimed");
          const failed = yield* waitFor(
            engine,
            blocked.runId,
            ({ run }) => run.state._tag === "Failed",
          );
          const outcome = failed.attempts[0]?.outcome;
          assert(outcome !== undefined && Option.isSome(outcome));
          assert(outcome.value._tag === "Failed");
          assert.deepStrictEqual(outcome.value.failure, blocker);

          // The Agent recorded its blocker on the Item, so the Item's content changed.
          const posted = submission({ number: 2, item: "blocked-item" });
          for (let poll = 0; poll < 3; poll += 1) {
            const held = yield* engine.submit(posted);
            assert(held._tag === "Held");
            assert.strictEqual(held.runId, blocked.runId);
          }
          assert(yield* hasNoRun(engine, posted));

          // A maintainer fixes main, a change the blocker comment did not make.
          const fixed = submission({ number: 3, item: "blocked-item" });
          const opened = yield* engine.submit(fixed);
          assert(opened._tag === "Claimed");
          yield* waitFor(engine, opened.runId, ({ run }) => run.state._tag === "Succeeded");
          assert.strictEqual((yield* engine.inspect(blocked.runId)).run.state._tag, "Failed");
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("evaluates the Item again once the operator resolves the blocker", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          blocker,
          Effect.succeed(stepResult("unblocked by the operator")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const blocked = yield* engine.submit(submission({ number: 4, item: "resolved-blocker" }));
          assert(blocked._tag === "Claimed");
          const failed = yield* waitFor(
            engine,
            blocked.runId,
            ({ run }) => run.state._tag === "Failed",
          );
          const posted = submission({ number: 5, item: "resolved-blocker" });
          assert.strictEqual((yield* engine.submit(posted))._tag, "Held");
          const attempt = failed.attempts[0];
          assert(attempt !== undefined);
          yield* engine.resolveFailure(blocked.runId, attempt.id);
          yield* waitFor(
            engine,
            yield* runIdFor(posted),
            ({ run }) => run.state._tag === "Succeeded",
          );
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("does not hold the Item after an Agent failure that is not a blocker", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          new AgentFailure({ message: "Claude Code is not logged in on Worker local" }),
          Effect.succeed(stepResult("ran after the login")),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const failed = yield* engine.submit(submission({ number: 6, item: "harness-item" }));
          assert(failed._tag === "Claimed");
          yield* waitFor(engine, failed.runId, ({ run }) => run.state._tag === "Failed");
          const changed = yield* engine.submit(submission({ number: 7, item: "harness-item" }));
          assert(changed._tag === "Claimed");
          yield* waitFor(engine, changed.runId, ({ run }) => run.state._tag === "Succeeded");
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );
});
