import { it } from "@effect/vitest";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { onTestFinished } from "vitest";
import { STOP_CHILDREN_SCRIPT } from "../../src/remote/container.ts";
import { DETECT_SCRIPT } from "../../src/ssh/runtime.ts";

const run = promisify(execFile);

it.each(["docker", "podman"])(
  "uses the selected %s CLI and propagates its failure",
  async (runtime) => {
    const directory = await mkdtemp("/tmp/usine-runtime-");
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const choice = join(directory, "runtime");
    await writeFile(choice, runtime);
    for (const name of ["docker", "podman"]) {
      await writeFile(
        join(directory, name),
        `#!/bin/sh\necho '${name}-info'\nexit "$RUNTIME_EXIT"\n`,
        { mode: 0o755 },
      );
    }
    const invoke = (exit: string) =>
      run("sh", ["-c", DETECT_SCRIPT, "sh", choice], {
        env: { PATH: `${directory}:${process.env.PATH}`, RUNTIME_EXIT: exit },
      });
    assert.strictEqual((await invoke("0")).stdout, `${runtime}\n${runtime}-info\n`);
    await assert.rejects(invoke("125"));
    await writeFile(choice, "invalid");
    await assert.rejects(invoke("0"), /Set \/etc\/usine\/container-runtime/u);
  },
);

it.each(["Error: No such container: usine-gone", "Error: no such container usine-gone"])(
  "recognizes a missing container during cancellation: %s",
  async (message) => {
    const directory = await mkdtemp("/tmp/usine-container-stop-");
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const cli = join(directory, "runtime");
    await writeFile(cli, '#!/bin/sh\nprintf "%s\\n" "$INSPECT_ERROR" >&2\nexit 125\n', {
      mode: 0o755,
    });
    const invoke = (error: string) =>
      run("sh", ["-c", STOP_CHILDREN_SCRIPT, "sh", cli, "usine-gone", "exit 99", "/checkout"], {
        env: { INSPECT_ERROR: error },
      });
    assert.strictEqual((await invoke(message)).stdout, "no-container\n");
    await assert.rejects(invoke("permission denied"), /permission denied/u);
  },
);
