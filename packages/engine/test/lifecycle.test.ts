import { assert, describe, it } from "@effect/vitest";
import { Attempt, AttemptId, AttemptNumber, AttemptTask, CapacityGroup } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import { AttemptFailed } from "@usine/core/attempt/outcome";
import { EventId } from "@usine/core/event";
import { LoopName } from "@usine/core/loop";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { StepName } from "@usine/core/step";
import { WorkerCredentialHolder, WorkerName } from "@usine/core/worker";
import { DateTime, Option } from "effect";
import { CapacityWait } from "../src/engine/engine.ts";
import { retryRun } from "../src/engine/lifecycle.ts";
import { testAgent } from "./support.ts";

describe("operator retry", () => {
  const runId = RunId.make("run-1");
  const at = DateTime.makeUnsafe("2026-11-20T10:00:00Z");
  const attempt = Attempt.make({
    id: AttemptId.make("attempt-1"),
    runId,
    stepName: StepName.make("review"),
    worker: WorkerName.make("local"),
    number: AttemptNumber.make(1),
    brain: testAgent.brain,
    task: AttemptTask.make("Review the pull request."),
    agent: testAgent.name,
    operatorIntervened: false,
    parentModel: Option.none(),
    startedAt: at,
    outcome: Option.none(),
    endedAt: Option.none(),
    salvage: Option.none(),
  });
  const infraFailed = Attempt.make({
    ...attempt,
    outcome: Option.some(
      AttemptFailed.make({
        failure: InfraFailure.make({
          message: "worker unreachable",
          cause: new Error("ECONNREFUSED"),
        }),
      }),
    ),
    endedAt: Option.some(at),
  });
  const wait = CapacityWait.make({
    group: CapacityGroup.make({
      harness: testAgent.brain.harness,
      model: testAgent.brain.model,
      holder: WorkerCredentialHolder.make({ worker: WorkerName.make("local") }),
    }),
    message: "You've hit your limit",
    since: at,
    refusals: 1,
    nextTryAt: DateTime.add(at, { minutes: 5 }),
    probes: [],
    runIds: [runId],
  });
  const decide = (
    state: RunState.RunState,
    attempts: ReadonlyArray<Attempt>,
    waits: Option.Option<CapacityWait>,
  ) =>
    retryRun(
      {
        run: Run.make({
          id: runId,
          eventId: EventId.make("event-1"),
          loop: LoopName.make("review"),
          state,
          openedAt: at,
        }),
        attempts,
      },
      waits,
    )._tag;

  it("starts the next Attempt now only of a Run that waits for its group without an Attempt", () => {
    // The claim of a slot after an infrastructure failure made the Run wait for its group.
    assert.strictEqual(
      decide(RunState.Running.make(), [infraFailed], Option.some(wait)),
      "RetryNow",
    );
    assert.strictEqual(
      decide(RunState.Running.make(), [infraFailed], Option.none()),
      "ResumePending",
    );
    assert.strictEqual(decide(RunState.Pending.make(), [], Option.some(wait)), "RetryNow");
    // An approved Run is Queued and waits for its group in that state.
    assert.strictEqual(decide(RunState.Queued.make(), [], Option.some(wait)), "RetryNow");
    assert.strictEqual(decide(RunState.Pending.make(), [], Option.none()), "RetryRejected");
    assert.strictEqual(decide(RunState.Queued.make(), [], Option.none()), "RetryRejected");
    // The engine's list of waiting Runs can lag behind the Run's state.
    assert.strictEqual(
      decide(RunState.Running.make(), [attempt], Option.some(wait)),
      "RetryRejected",
    );
    assert.strictEqual(decide(RunState.Waiting.make(), [], Option.some(wait)), "RetryRejected");
  });
});
