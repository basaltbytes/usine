import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { WorkerName } from "@usine/core/worker";
import { type Cause, Effect, Exit, Layer, Option, Queue, Ref, Schema, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import type { CredentialRoute } from "../../src/harness/capability.ts";
import { HarnessCatalog } from "../../src/harness/harness.ts";
import { bridgeClient } from "../../src/harness/opencode/bridge/client.ts";
import { BridgeRequest } from "../../src/harness/opencode/bridge/lines.ts";
import { opencode } from "../../src/harness/opencode/descriptor.ts";
import { openCodeRuntime } from "../../src/harness/opencode/opencode.ts";
import { OpenCodeServer } from "../../src/harness/opencode/server.ts";
import { Harnesses } from "../../src/harness/registry.ts";
import { ProbeTarget } from "../../src/harness/runtime.ts";
import { ChildBackend, ChildRequest, type SessionOperationError } from "../../src/runtime.ts";
import { childRequest, scriptedBackend, scriptedServer } from "./scripted-bridge.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeRequest));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

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

/** OpenCode's entry for `gpt-test` under the session's provider, with variants up to medium. */
const listed = {
  id: "gpt-test",
  providerID: "openai",
  enabled: true,
  variants: [{ id: "none" }, { id: "low" }, { id: "medium" }],
};

/**
 * A fake `OpenCodeServer` whose bridge lists `models` and answers every other request with status
 * 500. `requests` returns the method and path of each request that reached the bridge.
 */
const listingServer = (models: ReadonlyArray<Schema.Json>) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = Layer.succeed(OpenCodeServer)({
      stop: () => Effect.void,
      open: (target) =>
        Effect.gen(function* () {
          const input = yield* Queue.make<Uint8Array, Cause.Done>();
          const output = yield* Queue.make<Uint8Array, SessionOperationError | Cause.Done>();
          const client = yield* bridgeClient({
            sessionId: target.sessionId,
            input,
            output: Stream.fromQueue(output),
            generation: Option.none(),
          });
          const emit = (line: Schema.Json) =>
            encodeJson(line).pipe(
              Effect.orDie,
              Effect.flatMap((text) => Queue.offer(output, encoder.encode(`${text}\n`))),
            );
          yield* Queue.take(input).pipe(
            Effect.map((bytes) => decoder.decode(bytes).trimEnd()),
            Effect.flatMap(decodeRequest),
            Effect.orDie,
            Effect.tap((sent) =>
              Ref.update(requests, (all) => [...all, `${sent.method} ${sent.path}`]),
            ),
            Effect.flatMap((sent) =>
              sent.path.startsWith("/api/model")
                ? emit({ id: sent.id, status: 200, body: { data: [...models] } })
                : emit({ id: sent.id, status: 500, body: { message: "not scripted" } }),
            ),
            Effect.forever,
            Effect.ignoreCause,
            Effect.forkScoped,
          );
          yield* emit({ ready: true });
          yield* client.ready;
          return { ...client, retained: false };
        }),
    });
    return { layer, requests: Ref.get(requests) };
  });

/**
 * Launches a child session on `brain` over a bridge that lists `models`, and returns the launch's
 * failure with the requests that reached the bridge.
 */
const refusedLaunch = (
  models: ReadonlyArray<Schema.Json>,
  brain: Partial<Pick<BrainSpec, "model" | "effort">>,
) =>
  Effect.gen(function* () {
    const server = yield* listingServer(models);
    const launch = yield* Effect.gen(function* () {
      const backend = yield* ChildBackend;
      return yield* backend.launch(
        ChildRequest.make({
          ...childRequest,
          session: {
            ...childRequest.session,
            brain: BrainSpec.make({ ...childRequest.session.brain, ...brain }),
          },
        }),
      );
    }).pipe(Effect.provide(scriptedBackend(server.layer)), Effect.exit);
    const requests = yield* server.requests;
    assert.isTrue(
      requests.some((request) => request.startsWith("GET /api/model")),
      "the launch reads OpenCode's models",
    );
    assert.notInclude(requests, "POST /api/session", "the launch creates no OpenCode session");
    assert(Exit.isFailure(launch), "the launch fails");
    const reason = launch.cause.reasons[0];
    assert(reason?._tag === "Fail");
    return reason.error;
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

  it.effect("refuses a session whose effort has no OpenCode variant before creating it", () =>
    Effect.gen(function* () {
      const error = yield* refusedLaunch([listed], { effort: "max" });
      assert(error._tag === "UnsupportedEffortError");
      assert.include(error.message, "has no variant for effort max");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a session whose model OpenCode doesn't list before creating it", () =>
    Effect.gen(function* () {
      const error = yield* refusedLaunch([listed], { model: ModelId.make("gpt-missing") });
      assert(error._tag === "UnknownModelError");
      assert.include(error.message, 'OpenCode has no model "gpt-missing"');
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a session whose model OpenCode lists as disabled", () =>
    Effect.gen(function* () {
      const error = yield* refusedLaunch([{ ...listed, enabled: false }], {});
      assert(error._tag === "UnknownModelError");
      assert.include(error.message, 'OpenCode has no enabled model "gpt-test"');
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a session whose model OpenCode lists only for another provider", () =>
    Effect.gen(function* () {
      const error = yield* refusedLaunch([{ ...listed, providerID: "azure" }], {});
      assert(error._tag === "UnknownModelError");
      assert.strictEqual(error.message, 'OpenCode has no model "gpt-test" for the openai provider');
    }).pipe(Effect.scoped),
  );
});
