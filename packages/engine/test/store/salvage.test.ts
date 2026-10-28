import { assert, it } from "@effect/vitest";
import { AgentFailure, GitHubPushFailure } from "@usine/core/attempt/failure";
import { SalvagePushed, SalvageRef, SalvageRetained } from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import { StepResult } from "@usine/core/step/result";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Effect, Option, Result } from "effect";
import { RunStore } from "../../src/store/store.ts";
import { lifecycleSubmission, withRunStore } from "./support.ts";

const runId = RunId.make("refused-push");
const failure = new GitHubPushFailure({
  repository: lifecycleSubmission.repository,
  ref: "refs/heads/usine/salvage/refused-push/1",
  message:
    "GitHub refused the push (HTTP 403). The token is a single-repository installation token.",
});
const commit = CommitSha.make("b".repeat(40));
const retained = new SalvageRetained({
  path: "/checkout",
  commit: Option.some(commit),
  message: failure.message,
  pushFailure: Option.some(failure),
});

it.live.each(["completion", "restart", "closed", "reported-success"] as const)(
  "keeps a push refusal as the attempt failure during %s, including after salvage recovers",
  (phase) =>
    withRunStore(
      Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(lifecycleSubmission, runId);
        const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
        assert(started._tag === "AttemptStarted");
        const attempt = started.execution.attempt;
        if (phase === "closed")
          yield* store.finishAttempt(
            attempt,
            Result.fail(new AgentFailure({ message: "Agent stopped" })),
          );
        yield* store.recordSalvage(attempt.id, retained);
        if (phase === "completion" || phase === "reported-success") {
          const decision = yield* store.finishAttempt(
            attempt,
            phase === "reported-success"
              ? Result.succeed(
                  new StepResult({ message: "Parent finished before restart", facts: [] }),
                )
              : Result.fail(new AgentFailure({ message: "Agent stopped" })),
          );
          assert.strictEqual(decision._tag, "RunFailed");
        } else if (phase === "restart") {
          const decision = yield* store.beginAttempt(
            runId,
            WorkerName.make("local"),
            Option.none(),
          );
          assert.strictEqual(decision._tag, "AttemptRecoveryFailed");
        }
        const refused = yield* store.snapshot(runId);
        assert.strictEqual(refused.run.state._tag, "Failed");
        assert.lengthOf(refused.attempts, 1);
        const outcome = refused.attempts[0]?.outcome;
        assert(outcome !== undefined && Option.isSome(outcome) && outcome.value._tag === "Failed");
        assert.deepStrictEqual(outcome.value.failure, failure);
        assert.deepStrictEqual(refused.attempts[0]?.salvage, Option.some(retained));
        yield* store.recordSalvage(
          attempt.id,
          new SalvagePushed({
            ref: SalvageRef.make("usine/salvage/refused-push/1"),
            commit,
          }),
        );
        assert.deepStrictEqual((yield* store.snapshot(runId)).attempts[0]?.outcome, outcome);
      }),
    ),
);

it.live("keeps an operator cancellation when its salvage push is refused", () =>
  withRunStore(
    Effect.gen(function* () {
      const store = yield* RunStore;
      yield* store.recordAndClaim(lifecycleSubmission, runId);
      const started = yield* store.beginAttempt(runId, WorkerName.make("local"), Option.none());
      assert(started._tag === "AttemptStarted");
      yield* store.cancel(runId);
      yield* store.recordSalvage(started.execution.attempt.id, retained);
      const canceled = yield* store.snapshot(runId);
      assert.strictEqual(canceled.run.state._tag, "Canceled");
      assert.strictEqual(
        Option.getOrNull(canceled.attempts[0]?.outcome ?? Option.none())?._tag,
        "Canceled",
      );
    }),
  ),
);
