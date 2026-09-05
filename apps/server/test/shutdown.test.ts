import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "vitest";

const signalScenario = (
  mode:
    | "complete"
    | "force"
    | "deadline"
    | "startup"
    | "startup-force"
    | "startup-deadline"
    | "slow-cleanup",
) => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("./fixtures/shutdown.mjs", import.meta.url)),
      mode,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.status, 130, result.stderr);
  assert.notMatch(result.stdout, /ERROR admission still open/);
  return result.stdout;
};

describe("graceful process shutdown", () => {
  it("waits for admitted work before closing its scope on SIGTERM", () => {
    const output = signalScenario("complete");
    assert.match(output, /attempt completed/);
    assert.match(output, /exiting after graceful drain/);
    assert(output.indexOf("attempt completed") < output.indexOf("exiting after graceful drain"));
    assert.notMatch(output, /attempt interrupted/);
  });

  it("a second signal interrupts unfinished work without waiting for the deadline", () => {
    const output = signalScenario("force");
    assert.match(output, /reason: 'forced'/);
    assert.match(output, /attempt interrupted/);
  });

  it("the shutdown deadline interrupts work that never completes", () => {
    const output = signalScenario("deadline");
    assert.match(output, /reason: 'deadline'/);
    assert.match(output, /attempt interrupted/);
  });

  it("drains recovery during startup without starting trigger streams", () => {
    const output = signalScenario("startup");
    assert.match(output, /attempt completed/);
    assert.match(output, /startup completed/);
    assert.match(output, /exiting after graceful drain/);
    assert.notMatch(output, /triggers started|attempt interrupted/);
  });

  it.each(["startup-force", "startup-deadline"] as const)(
    "bounds interrupted startup: %s",
    (mode) => {
      const output = signalScenario(mode);
      assert.match(output, /attempt interrupted/);
      assert.notMatch(output, /startup completed|triggers started/);
    },
  );

  it("forces Attempt cancellation before a slow trigger finalizer completes", () => {
    const output = signalScenario("slow-cleanup");
    assert.match(output, /reason: 'forced'/);
    assert(output.indexOf("attempt interrupted") < output.indexOf("trigger cleanup completed"));
  });
});
