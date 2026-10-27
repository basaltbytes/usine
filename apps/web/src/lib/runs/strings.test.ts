import { AttemptNumber } from "@usine/core/attempt";
import { SalvagePushed, SalvageRef } from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { UnconfirmedStopView } from "@usine/orchestrator/operator";
import { assert, describe, it } from "vitest";
import { conflictingSalvageMessage, runStateLine } from "~/lib/runs/strings";

describe("salvage copy in the reader", () => {
  it("names the conflicting salvage a retry starts without", () => {
    const message = conflictingSalvageMessage(
      new SalvagePushed({
        ref: SalvageRef.make("usine/salvage/run/2"),
        commit: CommitSha.make("0123456789abcdef0123456789abcdef01234567"),
      }),
    );
    assert.include(message, "usine/salvage/run/2 at 0123456");
    assert.include(message, "Not applied");
    assert.include(message, "conflicts with the current revision");
  });
});

describe("run state while a parent task isn't confirmed stopped", () => {
  const stop = (runId: string) =>
    new UnconfirmedStopView({
      runId: RunId.make(runId),
      attemptNumber: AttemptNumber.make(1),
      worker: WorkerName.make("local"),
    });
  const run = { id: RunId.make("retrying"), state: "Running", attempts: [] } as const;

  it("names the run's own attempt and the worker it still ends on", () => {
    assert.strictEqual(
      runStateLine(run, stop("retrying")),
      "Waiting for attempt 1 to stop on local",
    );
  });

  it("names an earlier run's attempt", () => {
    assert.strictEqual(
      runStateLine(run, stop("canceled")),
      "Waiting for attempt 1 of an earlier run to stop on local",
    );
  });

  it("keeps the state without an unconfirmed stop", () => {
    assert.strictEqual(runStateLine(run), "Running, attempt 1");
  });
});
