import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { WorkerName } from "@usine/core/worker";
import { Effect, FileSystem, Layer, Option, Ref, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { hostOutput } from "../../src/child-host/command.ts";
import { HarnessCatalog } from "../../src/harness/harness.ts";
import { OPENCODE_VERSION, opencode } from "../../src/harness/opencode/descriptor.ts";
import { openCodeRuntime } from "../../src/harness/opencode/opencode.ts";
import { OpenCodeServer } from "../../src/harness/opencode/server.ts";
import { Harnesses } from "../../src/harness/registry.ts";
import { ProbeTarget } from "../../src/harness/runtime.ts";
import { SessionOperationError } from "../../src/runtime.ts";
import { collectLogs } from "../logs.ts";

const encoder = new TextEncoder();

/** Answers `opencode --version` with `output`. */
const versionCommand = (output: string) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert(command._tag === "StandardCommand");
        assert.strictEqual(command.command, "sh");
        assert.strictEqual(command.args.at(-1), "--version");
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(output)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

/** An `OpenCodeServer` that preflight must not start. */
const unusedServer = Layer.succeed(OpenCodeServer)({
  open: () => Effect.die(new Error("preflight started OpenCode")),
  stop: () => Effect.void,
});

/** Runs OpenCode preflight with `environment` on a local worker. */
const runPreflight = (environment: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const harnesses = yield* Harnesses;
    const runtime = yield* harnesses.runtime(opencode.id);
    return yield* runtime.preflight(
      BrainSpec.make({
        harness: Harness.make("opencode"),
        model: ModelId.make("gpt-test"),
        effort: "low",
      }),
      ProbeTarget.make({
        host: LocalProcess.make(),
        environment,
        placement: "local",
        credential: "api-key",
        worker: WorkerName.make("version-worker"),
        machine: Option.none(),
      }),
    );
  }).pipe(
    Effect.provide(
      Layer.unwrap(
        Effect.map(openCodeRuntime, (runtime) =>
          Harnesses.layerFrom(HarnessCatalog.make({ descriptors: [opencode] }), [runtime]),
        ),
      ),
    ),
  );

/** Runs OpenCode preflight on a local worker whose `opencode --version` prints `output`. */
const preflight = (output: string) =>
  runPreflight({ PATH: "/usr/bin:/bin" }).pipe(
    Effect.provide(Layer.merge(unusedServer, versionCommand(output))),
  );

/**
 * A stand-in for `opencode` that creates folders in OpenCode's XDG directories on every start, as
 * OpenCode 2.3.2 does, and fails when it can't. `serve` also creates OpenCode's database.
 */
const STUB_OPENCODE = [
  "#!/bin/sh",
  'mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/log" "${XDG_CONFIG_HOME:-$HOME/.config}/opencode" \\',
  '  "${XDG_STATE_HOME:-$HOME/.local/state}/opencode" "${XDG_CACHE_HOME:-$HOME/.cache}/opencode" || exit 1',
  `[ "$1" != --version ] || { echo "opencode v${OPENCODE_VERSION}"; exit 0; }`,
  "db=${OPENCODE_DB:-${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db}",
  'mkdir -p "$(dirname "$db")" && : > "$db"',
  "",
].join("\n");

/** A stand-in for an `opencode` that runs and fails. */
const FAILING_OPENCODE = ["#!/bin/sh", "echo 'opencode broke' >&2", "exit 1", ""].join("\n");

/** The commands that the probe scripts and `STUB_OPENCODE` run. */
const TOOLS = ["sh", "mktemp", "rm", "mkdir", "dirname"];

/**
 * Creates a scoped local worker whose command path has only `TOOLS` and, when given, `opencode` as
 * the script `opencode`. Its home is a file, so that no folder can be created in it, not even by
 * root. Its `TMPDIR` is an empty directory, and it exports `OPENCODE_DB`.
 */
const stubWorker = Effect.fn(function* (opencode: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-opencode-probe-" });
  const bin = `${root}/bin`;
  const tmp = `${root}/tmp`;
  yield* fs.makeDirectory(bin);
  yield* fs.makeDirectory(tmp);
  for (const tool of TOOLS) {
    const found = yield* Effect.findFirst(["/bin", "/usr/bin"], (dir) =>
      fs.exists(`${dir}/${tool}`),
    );
    assert(Option.isSome(found), `the test machine has ${tool}`);
    yield* fs.symlink(`${found.value}/${tool}`, `${bin}/${tool}`);
  }
  if (Option.isSome(opencode)) {
    yield* fs.writeFileString(`${bin}/opencode`, opencode.value);
    yield* fs.chmod(`${bin}/opencode`, 0o755);
  }
  yield* fs.writeFileString(`${root}/home`, "");
  const database = `${root}/worker/opencode.db`;
  return {
    environment: { PATH: bin, HOME: `${root}/home`, TMPDIR: tmp, OPENCODE_DB: database },
    /** The entries that the probes left in `TMPDIR`. */
    leftovers: fs.readDirectory(tmp),
    /** Whether a probe created the worker's `OPENCODE_DB`. */
    usedWorkerDatabase: fs.exists(database),
  };
});

describe("OpenCode preflight", () => {
  it.effect("reports another OpenCode release as unavailable without starting it", () =>
    Effect.gen(function* () {
      const readiness = yield* preflight("opencode v2.3.1\n");
      assert(readiness._tag === "HarnessUnavailableError");
      assert.strictEqual(readiness.capability, "version");
      assert.strictEqual(
        readiness.message,
        `The worker has opencode v2.3.1. Install @opencode/cli ${OPENCODE_VERSION}.`,
      );
    }),
  );

  it.effect("reports unrecognized version output as unavailable without starting OpenCode", () =>
    Effect.gen(function* () {
      const readiness = yield* preflight("OpenCode 2.3.2 (beta)\n");
      assert(readiness._tag === "HarnessUnavailableError");
      assert.strictEqual(readiness.capability, "version");
      assert.strictEqual(
        readiness.message,
        `The worker has an unrecognized OpenCode version. Install @opencode/cli ${OPENCODE_VERSION}.`,
      );
    }),
  );

  it.effect("runs both probes with OpenCode's directories outside the home directory", () =>
    Effect.gen(function* () {
      const worker = yield* stubWorker(Option.some(STUB_OPENCODE));
      const serve = yield* Ref.make(Option.none<{ exitCode: number; stderr: string }>());
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Runs the serve probe's command, then fails as if OpenCode never got ready.
      const server = Layer.succeed(OpenCodeServer)({
        open: (target) =>
          Effect.gen(function* () {
            assert(target.command !== undefined, "the probe starts OpenCode with its own script");
            const result = yield* hostOutput(target.host, {
              environment: worker.environment,
              command: target.command.command,
              args: [...target.command.args, "serve"],
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.orDie,
            );
            yield* Ref.set(
              serve,
              Option.some({ exitCode: result.exitCode, stderr: result.stderr }),
            );
            return yield* SessionOperationError.make({
              operation: "launch",
              sessionId: Option.none(),
              message: "The test serves no OpenCode",
              cause: undefined,
            });
          }),
        stop: () => Effect.void,
      });
      const readiness = yield* runPreflight(worker.environment).pipe(
        Effect.provide(server),
        Effect.flip,
      );
      assert.strictEqual(readiness.message, "The test serves no OpenCode");
      const served = yield* Ref.get(serve);
      assert.deepStrictEqual(served, Option.some({ exitCode: 0, stderr: "" }));
      const leftovers = yield* worker.leftovers;
      assert.deepStrictEqual(leftovers, [], "the probes remove their directories");
      const usedWorkerDatabase = yield* worker.usedWorkerDatabase;
      assert.isFalse(usedWorkerDatabase, "serve uses the probe's database");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports the exit code of an OpenCode that fails, and logs its error output", () => {
    const logs = collectLogs(["Warn"]);
    return Effect.gen(function* () {
      const worker = yield* stubWorker(Option.some(FAILING_OPENCODE));
      const readiness = yield* runPreflight(worker.environment).pipe(Effect.provide(unusedServer));
      assert(readiness._tag === "HarnessUnavailableError");
      assert.strictEqual(
        readiness.message,
        'opencode --version exited with code 1 on the worker. The log entry "Harness prerequisite check failed" has its error output.',
      );
      const failure = logs.records.find(
        ({ message }) =>
          Array.isArray(message) && message[0] === "Harness prerequisite check failed",
      );
      assert(failure !== undefined && Array.isArray(failure.message), "the failure is logged");
      assert.deepInclude(failure.message[1], {
        command: "opencode",
        exitCode: 1,
        stderr: "opencode broke",
      });
      const leftovers = yield* worker.leftovers;
      assert.deepStrictEqual(leftovers, [], "the probe removes its directory");
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, logs.layer)));
  });

  it.effect("reports the OpenCode installation when the worker has no opencode", () =>
    Effect.gen(function* () {
      const worker = yield* stubWorker(Option.none());
      const readiness = yield* runPreflight(worker.environment).pipe(Effect.provide(unusedServer));
      assert(readiness._tag === "HarnessUnavailableError");
      assert.strictEqual(
        readiness.message,
        "opencode --version failed. Check the OpenCode installation on the worker.",
      );
      const leftovers = yield* worker.leftovers;
      assert.deepStrictEqual(leftovers, [], "the probe removes its directory");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
