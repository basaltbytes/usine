import { assert, it } from "@effect/vitest";
import type { Attempt } from "@usine/core/attempt";
import {
  AgentFailure,
  BlockedFailure,
  GitHubPushFailure,
  InfraFailure,
} from "@usine/core/attempt/failure";
import { SalvageRetained } from "@usine/core/attempt/salvage";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { CommitSha } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { Comment, StepCompletion, StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { Context, Effect, Layer, Option, Result } from "effect";
import { CompletionCheck } from "../src/completion-check.ts";
import { RunEngine } from "../src/engine/engine.ts";
import { discardedSuccess } from "../src/engine/lifecycle.ts";
import { Submission } from "../src/engine/submission.ts";
import { StepExecutor } from "../src/step-executor.ts";
import { RunStore } from "../src/store/store.ts";
import { lifecycleSubmission } from "./store/fixtures.ts";
import { withRunStore } from "./store/support.ts";
import {
  committedBeforeCrash,
  conditionLayer,
  engineLayer,
  slottedExecutor,
  stepResult,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

const reviewed = StepResult.make({
  message: "Review finished.",
  facts: [
    Comment.make({
      url: new URL("https://github.com/basaltbytes/usine/pull/1#pullrequestreview-1"),
      kind: "review",
      at: Option.none(),
    }),
  ],
});

const rejecting = (verified: Array<Attempt>) =>
  Layer.succeed(CompletionCheck)({
    verify: (attempt) =>
      Effect.sync(() => verified.push(attempt)).pipe(
        Effect.andThen(
          AgentFailure.make({ message: "The review ended without an outcome label." }),
        ),
      ),
  });

const requiringLabels = Submission.make({
  ...submission({ number: 1 }),
  outcomeLabels: ["passed", "findings"],
});

it.live.each(["missing", "present", "blocked", "disabled"] as const)(
  "records the verified completion when outcome labels are %s",
  (scenario) =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const worker = yield* slottedExecutor([
          scenario === "blocked"
            ? Effect.fail(BlockedFailure.make({ message: "Delegation interrupted." }))
            : Effect.succeed(reviewed),
        ]);
        const verified: Array<readonly [Attempt, Submission]> = [];
        const check = Layer.succeed(CompletionCheck)({
          verify: (attempt, saved) =>
            Effect.gen(function* () {
              verified.push([attempt, saved]);
              if (scenario === "missing") {
                return yield* AgentFailure.make({
                  message: "The review ended without an outcome label.",
                });
              }
            }),
        });
        const requested = Submission.make({
          ...requiringLabels,
          outcomeLabels: scenario === "disabled" ? [] : requiringLabels.outcomeLabels,
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
          const [attempt] = finished.attempts;
          assert(attempt !== undefined && Option.isSome(attempt.outcome));
          assert.strictEqual(finished.attempts.length, 1);
          assert.deepStrictEqual(
            verified.map(([checked, saved]) => [checked.id, saved]),
            scenario === "missing" || scenario === "present" ? [[attempt.id, requested]] : [],
          );
          const outcome = attempt.outcome.value;
          if (succeeded) {
            assert.strictEqual(outcome._tag, "Succeeded");
            return;
          }
          assert(outcome._tag === "Failed");
          if (scenario === "blocked") {
            assert.strictEqual(outcome.failure._tag, "BlockedFailure");
            assert(Option.isNone(attempt.result));
            return;
          }
          assert.strictEqual(outcome.failure._tag, "AgentFailure");
          assert.strictEqual(outcome.failure.message, "The review ended without an outcome label.");
          // The rejected report keeps its message and facts on the Attempt.
          assert(Option.isSome(attempt.result));
          assert.strictEqual(attempt.result.value.message, reviewed.message);
          assert.deepStrictEqual(
            attempt.result.value.facts.map((fact) =>
              fact._tag === "Comment" ? fact.url.href : "",
            ),
            ["https://github.com/basaltbytes/usine/pull/1#pullrequestreview-1"],
          );
          assert.deepStrictEqual(attempt.result.value.attemptId, Option.some(attempt.id));
        }).pipe(
          Effect.provide(
            engineLayer(
              directory,
              worker.executor,
              conditionLayer(Effect.succeed("matches")),
              check,
            ),
          ),
        );
      }),
    ),
);

it.live("accepts outcome labels unverified on a host that provides the unverified check", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const worker = yield* slottedExecutor([Effect.succeed(stepResult("Finished."))]);
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(requiringLabels);
        assert(accepted._tag === "Claimed");
        yield* waitFor(engine, accepted.runId, ({ run }) => run.state._tag === "Succeeded");
      }).pipe(Effect.provide(engineLayer(directory, worker.executor)));
    }),
  ),
);

it.live("checks saved outcome labels before accepting a completion recovered after restart", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const runId = RunId.make("recovered-review");
      yield* committedBeforeCrash(directory, (store) =>
        Effect.gen(function* () {
          yield* store.recordAndClaim(requiringLabels, runId);
          const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
          assert.strictEqual(started._tag, "AttemptStarted");
        }),
      );
      const worker = yield* slottedExecutor([]);
      const services = yield* Layer.build(worker.executor);
      const executor = Layer.succeed(StepExecutor)({
        ...Context.get(services, StepExecutor),
        outcome: () => Effect.succeedSome(Result.succeed(StepCompletion.fromResult(reviewed))),
        execute: () => Effect.die("Recovery must use the stored completion."),
      });
      const verified: Array<Attempt> = [];
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        yield* engine.reconcile;
        const finished = yield* waitFor(engine, runId, ({ run }) => run.state._tag === "Failed");
        assert.strictEqual(finished.attempts.length, 1);
        const [attempt] = finished.attempts;
        assert(attempt !== undefined && Option.isSome(attempt.outcome));
        assert(attempt.outcome.value._tag === "Failed");
        assert.strictEqual(attempt.outcome.value.failure._tag, "AgentFailure");
        assert.deepStrictEqual(
          verified.map(({ id }) => id),
          [attempt.id],
        );
      }).pipe(
        Effect.provide(
          engineLayer(
            directory,
            executor,
            conditionLayer(Effect.succeed("matches")),
            rejecting(verified),
          ),
        ),
      );
    }),
  ),
);

it.live("skips the check when a refused push already fails the Attempt", () =>
  withInstance((directory) =>
    Effect.gen(function* () {
      const worker = yield* slottedExecutor([]);
      const services = yield* Layer.build(worker.executor);
      const pushFailure = GitHubPushFailure.make({
        repository: requiringLabels.repository,
        ref: "refs/heads/usine/salvage/review/1",
        message: "GitHub refused the push (HTTP 403).",
      });
      const executor = Layer.succeed(StepExecutor)({
        ...Context.get(services, StepExecutor),
        execute: (_, io) =>
          io.checkoutAcquired.pipe(
            Effect.andThen(
              io.salvage(
                SalvageRetained.make({
                  path: "/checkout",
                  commit: Option.some(CommitSha.make("b".repeat(40))),
                  message: pushFailure.message,
                  pushFailure: Option.some(pushFailure),
                }),
              ),
            ),
            Effect.as(StepCompletion.fromResult(reviewed)),
          ),
      });
      const verified: Array<Attempt> = [];
      yield* Effect.gen(function* () {
        const engine = yield* RunEngine;
        const accepted = yield* engine.submit(requiringLabels);
        assert(accepted._tag === "Claimed");
        const finished = yield* waitFor(
          engine,
          accepted.runId,
          ({ run }) => run.state._tag === "Failed",
        );
        const outcome = finished.attempts[0]?.outcome;
        assert(outcome !== undefined && Option.isSome(outcome) && outcome.value._tag === "Failed");
        assert.strictEqual(outcome.value.failure._tag, "GitHubPushFailure");
        assert.deepStrictEqual(verified, []);
      }).pipe(
        Effect.provide(
          engineLayer(
            directory,
            executor,
            conditionLayer(Effect.succeed("matches")),
            rejecting(verified),
          ),
        ),
      );
    }),
  ),
);

const onItem = (item: string) =>
  Submission.make({
    ...lifecycleSubmission,
    event: Event.make({
      ...lifecycleSubmission.event,
      id: EventId.make(`event-${item}`),
      dedupKey: DedupKey.make(`lifecycle/${item}`),
    }),
    itemKey: ItemKey.make(item),
  });

it.live("names why the Run would not record a success", () =>
  withRunStore(
    Effect.gen(function* () {
      const store = yield* RunStore;
      const worker = WorkerName.make("local");
      const begin = Effect.fn("test.begin")(function* (runId: RunId) {
        const started = yield* store.beginAttempt(runId, worker, Option.none());
        assert(started._tag === "AttemptStarted");
        return started.execution.attempt;
      });
      const expectReason = (
        runId: RunId,
        attempt: Attempt,
        expected: ReturnType<typeof discardedSuccess>,
      ) =>
        store
          .snapshot(runId)
          .pipe(
            Effect.map((current) =>
              assert.deepStrictEqual(discardedSuccess(current, attempt.id), expected),
            ),
          );

      const pushed = RunId.make("pushed");
      yield* store.recordAndClaim(onItem("pushed"), pushed);
      const open = yield* begin(pushed);
      yield* expectReason(pushed, open, Option.none());
      yield* store.recordSalvage(
        open.id,
        SalvageRetained.make({
          path: "/checkout",
          commit: Option.none(),
          message: "refused",
          pushFailure: Option.some(
            GitHubPushFailure.make({
              repository: lifecycleSubmission.repository,
              ref: "refs/heads/salvage",
              message: "refused",
            }),
          ),
        }),
      );
      yield* expectReason(pushed, open, Option.some("PushFailed"));

      const replaced = RunId.make("replaced");
      yield* store.recordAndClaim(onItem("replaced"), replaced);
      const first = yield* begin(replaced);
      const retried = yield* store.finishAttempt(
        first,
        Result.fail(InfraFailure.make({ message: "worker lost", cause: "test" })),
      );
      assert.strictEqual(retried._tag, "RetryAttempt");
      yield* begin(replaced);
      yield* expectReason(replaced, first, Option.some("AttemptReplaced"));

      const canceled = RunId.make("canceled");
      yield* store.recordAndClaim(onItem("canceled"), canceled);
      const running = yield* begin(canceled);
      yield* store.cancel(canceled);
      yield* expectReason(canceled, running, Option.some("RunNotRunning"));
    }),
  ),
);
