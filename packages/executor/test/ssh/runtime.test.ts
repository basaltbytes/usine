import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Config, Option, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { strict as assert } from "node:assert";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { promisify } from "node:util";
import {} from "@effect/vitest";
import { STOP_CHILDREN_SCRIPT } from "../../src/remote/container.ts";
import { DETECT_SCRIPT, PODMAN_LIMITS_SCRIPT } from "../../src/ssh/runtime.ts";

const run = promisify(execFile);

it.live.each(["docker", "podman"])(
  "uses the selected %s CLI and propagates its failure",
  (runtime) =>
    Effect.gen(function* () {
      const actual1 = yield* Config.option(Config.String("PATH"));
      const environmentPATH1 = Option.getOrUndefined(actual1);
      const directory = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeTempDirectory({
          directory: dirname("/tmp/usine-runtime-"),
          prefix: basename("/tmp/usine-runtime-"),
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(directory, { recursive: true, force: true }),
        ).pipe(Effect.orDie),
      );
      const choice = join(directory, "runtime");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(choice, runtime),
      );
      for (const name of ["docker", "podman"]) {
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(
            join(directory, name),
            `#!/bin/sh\necho '${name}-info'\nexit "$RUNTIME_EXIT"\n`,
            { mode: 0o755 },
          ),
        );
      }
      const invoke = (exit: string) =>
        run("sh", ["-c", DETECT_SCRIPT, "sh", choice], {
          env: { PATH: `${directory}:${environmentPATH1}`, RUNTIME_EXIT: exit },
        });
      assert.strictEqual(
        (yield* Effect.promise(() => invoke("0"))).stdout,
        `${runtime}\n${runtime}-info\n`,
      );
      yield* Effect.promise(() => assert.rejects(invoke("125")));
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(choice, "invalid"),
      );
      yield* Effect.promise(() =>
        assert.rejects(invoke("0"), /Set \/etc\/usine\/container-runtime/u),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live.each(["Error: No such container: usine-gone", "Error: no such container usine-gone"])(
  "recognizes a missing container during cancellation: %s",
  (message) =>
    Effect.gen(function* () {
      const directory = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeTempDirectory({
          directory: dirname("/tmp/usine-container-stop-"),
          prefix: basename("/tmp/usine-container-stop-"),
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(directory, { recursive: true, force: true }),
        ).pipe(Effect.orDie),
      );
      const cli = join(directory, "runtime");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          cli,
          '#!/bin/sh\nprintf "%s\\n" "$INSPECT_ERROR" >&2\nexit 125\n',
          {
            mode: 0o755,
          },
        ),
      );
      const invoke = (error: string) =>
        run("sh", ["-c", STOP_CHILDREN_SCRIPT, "sh", cli, "usine-gone", "exit 99", "/checkout"], {
          env: { INSPECT_ERROR: error },
        });
      assert.strictEqual((yield* Effect.promise(() => invoke(message))).stdout, "no-container\n");
      yield* Effect.promise(() =>
        assert.rejects(invoke("permission denied"), /permission denied/u),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live.each([
  { cpus: 0.57, cpuMax: "56999 100000", accepted: true },
  { cpus: 1.5, cpuMax: "150000 100000", accepted: true },
  { cpus: 1, cpuMax: "100000 100000", accepted: true },
  { cpus: 0.57, cpuMax: "56998 100000", accepted: false },
  { cpus: 0.57, cpuMax: "58000 100000", accepted: false },
  { cpus: 0.57, cpuMax: "max 100000", accepted: false },
  { cpus: 0.57, cpuMax: "56999 0", accepted: false },
])("checks Podman's integer CPU quota: $cpus CPUs, cpu.max=$cpuMax", ({ cpus, cpuMax, accepted }) =>
  Effect.gen(function* () {
    const directory = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.makeTempDirectory({
        directory: dirname("/tmp/usine-cgroup-"),
        prefix: basename("/tmp/usine-cgroup-"),
      }),
    );
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(directory, { recursive: true, force: true }),
      ).pipe(Effect.orDie),
    );
    for (const [file, value] of Object.entries({
      "cpu.max": cpuMax,
      "memory.max": "268435456",
      "memory.swap.max": "0",
      "pids.max": "64",
    })) {
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(join(directory, file), `${value}\n`),
      );
    }
    const probe = run("sh", [
      "-ec",
      PODMAN_LIMITS_SCRIPT.replaceAll("/sys/fs/cgroup", directory),
      "sh",
      String(cpus),
      "268435456",
      "64",
    ]);
    if (accepted) yield* Effect.promise(() => probe);
    else yield* Effect.promise(() => assert.rejects(probe));
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);
