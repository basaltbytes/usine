import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { WorkerName } from "@usine/core/worker";
import { Effect, Layer, Option, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { HarnessCatalog } from "../../src/harness/harness.ts";
import { OPENCODE_VERSION, opencode } from "../../src/harness/opencode/descriptor.ts";
import { openCodeRuntime } from "../../src/harness/opencode/opencode.ts";
import { OpenCodeServer } from "../../src/harness/opencode/server.ts";
import { Harnesses } from "../../src/harness/registry.ts";
import { ProbeTarget } from "../../src/harness/runtime.ts";

const encoder = new TextEncoder();

/** Answers `opencode --version` with `output`. */
const versionCommand = (output: string) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert(command._tag === "StandardCommand");
        assert.deepStrictEqual([command.command, ...command.args], ["opencode", "--version"]);
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

/** Runs OpenCode preflight on a local worker whose `opencode --version` prints `output`. */
const preflight = (output: string) =>
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
        environment: { PATH: "/usr/bin:/bin" },
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
      ).pipe(Layer.provide(unusedServer), Layer.provide(versionCommand(output))),
    ),
  );

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
});
