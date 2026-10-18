import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "vitest";

const SCENARIO_TIMEOUT_MS = 30_000;

describe("SIGHUP", { timeout: SCENARIO_TIMEOUT_MS + 10_000 }, () => {
  it("reloads the instance folder on each signal instead of ending the process", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("./fixtures/hangup.mjs", import.meta.url)),
      ],
      { encoding: "utf8", timeout: SCENARIO_TIMEOUT_MS },
    );
    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /reload 1\n[\s\S]*reload 2\n[\s\S]*still running/);
  });
});
