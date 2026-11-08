import { assert, it } from "@effect/vitest";
import { AgentFailure, BlockedFailure } from "@usine/core/attempt/failure";
import { Context, Effect, Layer, Option, Result } from "effect";
import { RunEngine } from "../src/engine/engine.ts";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { StepCompletion } from "@usine/core/step/result";
import { Submission } from "../src/engine/submission.ts";
import { CompletionCheck, StepExecutor } from "../src/step-executor.ts";
import {
  committedBeforeCrash,
  engineLayer,
  slottedExecutor,
  stepResult,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

it.live.each(["missing", "present", "blocked", "disabled"] as const)(
  "records the verified completion when outcome labels are %s",
  (scenario) =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const worker = yield* slottedExecutor([
          scenario === "blocked"
            ? Effect.fail(BlockedFailure.make({ message: "Delegation interrupted." }))
            : Effect.succeed(stepResult("Review finished.")),
        ]);
        const verified: Submission[] = [];
        const check = Layer.succeed(CompletionCheck)((saved) =>
          Effect.gen(function* () {
            verified.push(saved);
            if (scenario === "missing") {
              return yield* AgentFailure.make({
                message: "The review ended without an outcome label.",
              });
            }
          }),
        );
        const requested = Submission.make({
          ...submission({ number: 1 }),
          outcomeLabels: scenario === "disabled" ? [] : ["passed", "findings"],
        });
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(requested);
          assert(accepted._tag === "Claimed");
          const succeeded = scenario === "present" || scenario === "disabled";
          const finished = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === (succeeded ? "Succeeded" : "Failed"),
          );
          const outcome = finished.attempts[0]?.outcome;
          assert(outcome !== undefined && Option.isSome(outcome));
          assert.strictEqual(outcome.value._tag, succeeded ? "Succeeded" : "Failed");
          if (outcome.value._tag === "Failed") {
            assert.strictEqual(
              outcome.value.failure._tag,
              scenario === "blocked" ? "BlockedFailure" : "AgentFailure",
            );
          }
          assert.strictEqual(finished.attempts.length, 1);
          assert.deepStrictEqual(
            verified,
            scenario === "missing" || scenario === "present" ? [requested] : [],
          );
        }).pipe(Effect.provide(engineLayer(directory, worker.executor).pipe(Layer.provide(check))));
      }),
    ),
);

it.live("fails closed when outcome labels have no configured verifier", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const worker = yield* slottedExecutor([Effect.succeed(stepResult("Finished."))]);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(
          Submission.make({
            ...submission({ number: 1 }),
            outcomeLabels: ["passed"],
          }),
        );
        assert(accepted._tag === "Claimed");
        const finished = yield* waitFor(
          engine,
          accepted.runId,
          ({ run }) => run.state._tag === "Failed",
        );
        assert.strictEqual(finished.attempts.length, 1);
      }).pipe(Effect.provide(engineLayer(directory, worker.executor)));
    }),
  ),
);

it.live("checks saved outcome labels before accepting a completion recovered after restart", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const requested = Submission.make({
        ...submission({ number: 1 }),
        outcomeLabels: ["passed", "findings"],
      });
      const runId = RunId.make("recovered-review");
      yield* committedBeforeCrash(directory, (store) =>
        Effect.gen(function* () {
          yield* store.recordAndClaim(requested, runId);
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert.strictEqual(started._tag, "AttemptStarted");
        }),
      );
      const worker = yield* slottedExecutor([]);
      const services = yield* Layer.build(worker.executor);
      const executor = Layer.succeed(StepExecutor)({
        ...Context.get(services, StepExecutor),
        outcome: () =>
          Effect.succeedSome(
            Result.succeed(StepCompletion.fromResult(stepResult("Review finished."))),
          ),
        execute: () => Effect.die("Recovery must use the stored completion."),
      });
      const check = Layer.succeed(CompletionCheck)((saved) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(saved.outcomeLabels, requested.outcomeLabels);
          return yield* AgentFailure.make({
            message: "The review ended without an outcome label.",
          });
        }),
      );
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        yield* engine.reconcile;
        const finished = yield* waitFor(engine, runId, ({ run }) => run.state._tag === "Failed");
        assert.strictEqual(finished.attempts.length, 1);
        const outcome = finished.attempts[0]?.outcome;
        assert(outcome !== undefined && Option.isSome(outcome) && outcome.value._tag === "Failed");
        assert.strictEqual(outcome.value.failure._tag, "AgentFailure");
      }).pipe(Effect.provide(engineLayer(directory, executor).pipe(Layer.provide(check))));
    }),
  ),
);
