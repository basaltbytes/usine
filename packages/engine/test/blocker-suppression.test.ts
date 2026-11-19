import { assert, describe, it } from "@effect/vitest";
import { AgentFailure } from "@usine/core/attempt/failure";
import { Effect, Ref } from "effect";
import { RunEngine } from "../src/engine/engine.ts";
import {
  type AttemptPlan,
  engineLayer,
  executorLayer,
  stepResult,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

describe("Attempts that end with a blocker", () => {
  it.live("does not suppress the Item after an Agent failure that is not a blocker", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          AgentFailure.make({ message: "Claude Code is not logged in on Worker local" }),
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
