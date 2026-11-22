import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { WorkerName } from "@usine/core/worker";
import { Effect, Exit, Layer, Option, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import type { CredentialRoute } from "../../src/harness/capability.ts";
import { HarnessCatalog } from "../../src/harness/harness.ts";
import { opencode } from "../../src/harness/opencode/descriptor.ts";
import { openCodeRuntime } from "../../src/harness/opencode/opencode.ts";
import { Harnesses } from "../../src/harness/registry.ts";
import { ProbeTarget } from "../../src/harness/runtime.ts";
import { ChildBackend, ChildRequest } from "../../src/runtime.ts";
import { childRequest, scriptedBackend, scriptedServer } from "./scripted-bridge.ts";

const encoder = new TextEncoder();

/** Answers `opencode --version` with the pinned release. */
const versionCommand = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
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
        stdout: Stream.make(encoder.encode("opencode v2.3.2\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  ),
);

const ProbeConfig = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    providers: Schema.Struct({
      openai: Schema.Struct({
        settings: Schema.Struct({
          apiKey: Schema.String,
          baseURL: Schema.optionalKey(Schema.String),
        }),
      }),
    }),
  }),
);

const preflight = (model: string, credential: CredentialRoute) =>
  Effect.gen(function* () {
    const server = yield* scriptedServer;
    const readiness = yield* Effect.gen(function* () {
      const harnesses = yield* Harnesses;
      const runtime = yield* harnesses.runtime(opencode.id);
      return yield* runtime.preflight(
        BrainSpec.make({
          harness: Harness.make("opencode"),
          model: ModelId.make(model),
          effort: "low",
        }),
        ProbeTarget.make({
          host: LocalProcess.make(),
          environment: { PATH: "/usr/bin:/bin" },
          placement: "local",
          credential,
          worker: WorkerName.make("model-worker"),
          machine: Option.none(),
        }),
      );
    }).pipe(
      Effect.provide(
        Layer.unwrap(
          Effect.map(openCodeRuntime, (runtime) =>
            Harnesses.layerFrom(HarnessCatalog.make({ descriptors: [opencode] }), [runtime]),
          ),
        ).pipe(Layer.provide(server.layer), Layer.provide(versionCommand)),
      ),
    );
    const bridge = yield* server.bridge.pipe(Effect.timeoutOption("1 second"));
    return { readiness, target: Option.map(bridge, ({ target }) => target) };
  });

describe("OpenCode model check", () => {
  for (const [credential, token] of [
    ["gateway", "USINE_GATEWAY_TOKEN"],
    ["gateway-api-key", "USINE_GATEWAY_TOKEN"],
    ["api-key", "OPENAI_API_KEY"],
  ] as const)
    it.effect(`checks the model through GET /api/model on the ${credential} route`, () =>
      Effect.gen(function* () {
        const { readiness, target } = yield* preflight("gpt-test", credential);
        assert.strictEqual(readiness._tag, "HarnessReady");
        assert(Option.isSome(target), "the probe starts OpenCode");
        const command = target.value.command;
        assert(command !== undefined, "the probe starts OpenCode with its own script");
        assert.strictEqual(command.command, "sh");
        const config = yield* Schema.decodeUnknownEffect(ProbeConfig)(command.args.at(-1));
        assert.strictEqual(config.model, "openai/gpt-test");
        assert.strictEqual(config.providers.openai.settings.apiKey, `{env:${token}}`);
        assert.isUndefined(config.providers.openai.settings.baseURL);
      }).pipe(Effect.scoped),
    );

  it.effect("reports a model that OpenCode doesn't list as unavailable", () =>
    Effect.gen(function* () {
      const { readiness } = yield* preflight("gpt-missing", "api-key");
      assert(readiness._tag === "HarnessUnavailableError");
      assert.include(readiness.message, 'OpenCode has no model "gpt-missing"');
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a session whose model OpenCode doesn't list before creating it", () =>
    Effect.gen(function* () {
      const server = yield* scriptedServer;
      const launch = yield* Effect.gen(function* () {
        const backend = yield* ChildBackend;
        return yield* backend.launch(
          ChildRequest.make({
            ...childRequest,
            session: {
              ...childRequest.session,
              brain: BrainSpec.make({ ...childRequest.session.brain, effort: "max" }),
            },
          }),
        );
      }).pipe(Effect.provide(scriptedBackend(server.layer)), Effect.exit);
      assert(Exit.isFailure(launch));
      const error = launch.cause.reasons[0];
      assert(error?._tag === "Fail");
      assert.strictEqual(error.error._tag, "UnsupportedEffortError");
    }).pipe(Effect.scoped),
  );
});
