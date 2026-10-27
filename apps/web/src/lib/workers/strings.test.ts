import { RunId } from "@usine/core/run";
import { assert, describe, it } from "vitest";
import { machineFixture, pauseFixture } from "~/lib/runs/machine-fixture";
import { runStateLine } from "~/lib/runs/strings";
import { creationFailuresLine, machineCreationLine, nextCreationLine } from "~/lib/workers/strings";

describe("machine copy for provisioned workers", () => {
  const local = (day: number, hours: number, minutes: number) =>
    new Date(2026, 9, day, hours, minutes).toISOString();
  const now = Date.parse(local(25, 19, 40));

  it("says a queued run's machine is being created, with the provider", () => {
    const queued = { id: RunId.make("queued"), state: "Queued", attempts: [] } as const;
    assert.strictEqual(
      runStateLine(queued, null, machineFixture({ provider: "boat" })),
      "Queued, creating a Boat machine",
    );
    assert.strictEqual(
      runStateLine(queued, null, machineFixture({ state: "ready", id: "52341896" })),
      "Queued, no free worker",
    );
    assert.strictEqual(
      machineCreationLine(machineFixture({ since: local(25, 19, 37) }), now),
      "Creating a Hetzner machine, started 3m ago",
    );
  });

  it("gives the next creation time, with the day once it is not today", () => {
    assert.strictEqual(
      nextCreationLine(pauseFixture({ retryAt: local(25, 19, 46) }), now),
      "Next try at 19:46",
    );
    assert.strictEqual(
      nextCreationLine(pauseFixture({ retryAt: local(26, 7, 46) }), now),
      "Next try at 26 Oct 07:46",
    );
    assert.strictEqual(
      nextCreationLine(pauseFixture({ retryAt: local(25, 19, 30), blocked: false }), now),
      "Pause ended at 19:30",
    );
  });

  it("counts failed creations in a row", () => {
    assert.strictEqual(
      creationFailuresLine(pauseFixture({ failures: 1, failedAt: local(25, 19, 31) }), now),
      "Failed once, last at 19:31",
    );
    assert.strictEqual(
      creationFailuresLine(pauseFixture({ failures: 4, failedAt: local(24, 23, 2) }), now),
      "Failed 4 times in a row, last at 24 Oct 23:02",
    );
  });
});
