import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { ChildSession } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import {
  type Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { AdmissionContext } from "../../src/harness/admission.ts";
import type { CredentialRoute } from "../../src/harness/capability.ts";
import { HarnessCatalog } from "../../src/harness/harness.ts";
import { bridgeClient } from "../../src/harness/opencode/bridge/client.ts";
import { BridgeRequest } from "../../src/harness/opencode/bridge/lines.ts";
import { serveConfig, sessionCredential } from "../../src/harness/opencode/config.ts";
import {
  OPENCODE_BASE_URL,
  OPENCODE_GO_BASE_URL,
  OPENCODE_OPENAI_BASE_URL,
  opencode,
} from "../../src/harness/opencode/descriptor.ts";
import { modelChoice } from "../../src/harness/opencode/model.ts";
import { openCodeRuntime } from "../../src/harness/opencode/opencode.ts";
import { type OpenCodeTarget, OpenCodeServer } from "../../src/harness/opencode/server.ts";
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
      assert.strictEqual(command.command, "sh");
      assert.strictEqual(command.args.at(-1), "--version");
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
    const bodies = yield* Ref.make<ReadonlyArray<BridgeRequest["body"]>>([]);
    const targets = yield* Ref.make<ReadonlyArray<OpenCodeTarget>>([]);
    const layer = Layer.succeed(OpenCodeServer)({
      stop: () => Effect.void,
      open: (target) =>
        Effect.gen(function* () {
          yield* Ref.update(targets, (all) => [...all, target]);
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
              Ref.update(requests, (all) => [...all, `${sent.method} ${sent.path}`]).pipe(
                Effect.andThen(Ref.update(bodies, (all) => [...all, sent.body])),
              ),
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
    return {
      layer,
      requests: Ref.get(requests),
      bodies: Ref.get(bodies),
      targets: Ref.get(targets),
    };
  });

/**
 * Launches a child session on `brain` over a bridge that lists `models`, and returns the launch's
 * failure with the requests that reached the bridge.
 */
const refusedLaunch = (
  models: ReadonlyArray<Schema.Json>,
  brain: Partial<Pick<BrainSpec, "model" | "effort">>,
  request: ChildRequest = childRequest,
) =>
  Effect.gen(function* () {
    const server = yield* listingServer(models);
    const launch = yield* Effect.gen(function* () {
      const backend = yield* ChildBackend;
      return yield* backend.launch(
        ChildRequest.make({
          ...request,
          session: {
            ...request.session,
            brain: BrainSpec.make({ ...request.session.brain, ...brain }),
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

/** Returns `request` with its brain's model set to `model`. */
const withModel = (request: ChildRequest, model: string) =>
  ChildRequest.make({
    ...request,
    session: ChildSession.make({
      ...request.session,
      brain: BrainSpec.make({ ...request.session.brain, model: ModelId.make(model) }),
    }),
  });

/**
 * A child request for `opencode-go/glm-test` on the gateway route, whose gateway holds the plan's
 * slot.
 */
const goRequest = ChildRequest.make({
  ...withModel(childRequest, "opencode-go/glm-test"),
  environment: {
    HOME: "/home/scripted",
    USINE_GATEWAY_TOKEN: "caller-token",
    [OPENCODE_GO_BASE_URL]: "http://llm.gw.test/opencode-go",
  },
  session: ChildSession.make({
    ...withModel(childRequest, "opencode-go/glm-test").session,
    gatewayCredential: Option.some("api-key"),
  }),
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

  it.effect("checks a Go model in preflight against the opencode-go provider", () =>
    Effect.gen(function* () {
      const { readiness } = yield* preflight("opencode-go/gpt-test", "gateway-api-key");
      assert(readiness._tag === "HarnessUnavailableError");
      assert.strictEqual(
        readiness.message,
        'OpenCode has no model "gpt-test" for the opencode-go provider',
      );
    }).pipe(Effect.scoped),
  );

  // The refused probe starts no bridge, which the helper waits a second for.
  it.live(
    "refuses a provider that OpenCode doesn't list in preflight, with the list, before starting OpenCode",
    () =>
      Effect.gen(function* () {
        const { readiness, target } = yield* preflight("anthropic/claude-test", "gateway-api-key");
        assert(readiness._tag === "HarnessUnavailableError");
        assert.strictEqual(
          readiness.message,
          'OpenCode has no provider "anthropic" for the model "anthropic/claude-test". Choose one of openai, opencode-go as <provider>/<model>; a model ID without a provider is openai\'s.',
        );
        assert(Option.isNone(target), "the probe doesn't start OpenCode");
      }).pipe(Effect.scoped),
  );

  for (const [name, request, message] of [
    [
      "a provider that OpenCode doesn't list",
      withModel(childRequest, "anthropic/claude-test"),
      'OpenCode has no provider "anthropic" for the model "anthropic/claude-test". Choose one of openai, opencode-go as <provider>/<model>; a model ID without a provider is openai\'s.',
    ],
    [
      "a Go model on a gateway route whose gateway doesn't hold the plan's slot",
      ChildRequest.make({
        ...goRequest,
        environment: {
          HOME: "/home/scripted",
          USINE_GATEWAY_TOKEN: "caller-token",
          [OPENCODE_OPENAI_BASE_URL]: "http://llm.gw.test/openai-responses/v1",
        },
      }),
      'The gateway holds no OpenCode Go credential for the model "opencode-go/glm-test". Connect one for opencode-go at the gateway, and list its slot opencode-go in the worker\'s llm_providers.',
    ],
    [
      "a Go model on the api-key route",
      withModel(childRequest, "opencode-go/glm-test"),
      "opencode cannot run as coding-agent at local: lacks credential-route (OpenCode reaches OpenCode Go models only through a gateway that holds the provider's credential, and the api-key route has none)",
    ],
  ] as const)
    it.effect(`refuses ${name} at launch before opening a bridge`, () =>
      Effect.gen(function* () {
        const server = yield* listingServer([
          { ...listed, id: "glm-test", providerID: "opencode-go" },
        ]);
        const launch = yield* Effect.gen(function* () {
          const backend = yield* ChildBackend;
          return yield* backend.launch(request);
        }).pipe(Effect.provide(scriptedBackend(server.layer)), Effect.exit);
        assert(Exit.isFailure(launch), "the launch fails");
        const reason = launch.cause.reasons[0];
        assert(reason?._tag === "Fail");
        assert.strictEqual(reason.error.message, message);
        const targets = yield* server.targets;
        assert.deepStrictEqual(targets, [], "no bridge opens");
      }).pipe(Effect.scoped),
    );

  it.effect("refuses a Go session whose model OpenCode lists only for OpenAI", () =>
    Effect.gen(function* () {
      const error = yield* refusedLaunch([{ ...listed, id: "glm-test" }], {}, goRequest);
      assert(error._tag === "UnknownModelError");
      assert.strictEqual(
        error.message,
        'OpenCode has no model "glm-test" for the opencode-go provider',
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "starts a Go session on the gateway's slot with the caller token, and creates it with the plan's model",
    () =>
      Effect.gen(function* () {
        const server = yield* listingServer([
          { ...listed, id: "glm-test" },
          { ...listed, id: "glm-test", providerID: "opencode-go" },
        ]);
        yield* Effect.gen(function* () {
          const backend = yield* ChildBackend;
          return yield* backend.launch(goRequest);
        }).pipe(Effect.provide(scriptedBackend(server.layer)), Effect.exit);
        const [target] = yield* server.targets;
        assert(target !== undefined);
        const config = yield* Schema.decodeUnknownEffect(GoConfig)(
          target.environment.USINE_OPENCODE_SERVE_OPENCODE_CONFIG_CONTENT,
        );
        assert.deepStrictEqual(config.providers["opencode-go"].settings, {
          apiKey: "{env:USINE_GATEWAY_TOKEN}",
          transport: "http",
          baseURL: "{env:USINE_OPENCODE_GO_BASE_URL}",
        });
        const requests = yield* server.requests;
        const created = (yield* server.bodies)[requests.indexOf("POST /api/session")];
        assert.deepStrictEqual(
          Schema.decodeUnknownOption(CreatedModel)(created),
          Option.some({ model: { providerID: "opencode-go", id: "glm-test", variant: "low" } }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "starts an OpenAI session on the attempt's API key when its worker reports the key as the gateway's api-key kind",
    () =>
      Effect.gen(function* () {
        const server = yield* listingServer([listed]);
        yield* Effect.gen(function* () {
          const backend = yield* ChildBackend;
          return yield* backend.launch(
            ChildRequest.make({
              ...childRequest,
              environment: {
                HOME: "/home/scripted",
                [OPENCODE_BASE_URL]: "https://api.openai.com/v1",
              },
              session: ChildSession.make({
                ...childRequest.session,
                gatewayCredential: Option.some("api-key"),
              }),
            }),
          );
        }).pipe(Effect.provide(scriptedBackend(server.layer)), Effect.exit);
        const [target] = yield* server.targets;
        assert(target !== undefined);
        const config = yield* Schema.decodeUnknownEffect(OpenAiConfig)(
          target.environment.USINE_OPENCODE_SERVE_OPENCODE_CONFIG_CONTENT,
        );
        assert.deepStrictEqual(config.providers.openai.settings, {
          apiKey: "{env:OPENAI_API_KEY}",
          transport: "http",
          baseURL: "{env:USINE_OPENCODE_BASE_URL}",
        });
      }).pipe(Effect.scoped),
  );
});

const OpenAiConfig = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.Struct({
      openai: Schema.Struct({ settings: Schema.Record(Schema.String, Schema.String) }),
    }),
  }),
);

const GoConfig = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.Struct({
      "opencode-go": Schema.Struct({ settings: Schema.Record(Schema.String, Schema.String) }),
    }),
  }),
);

const CreatedModel = Schema.Struct({
  model: Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: Schema.String }),
});

describe("OpenCode provider/model notation", () => {
  const brain = (model: string) =>
    BrainSpec.make({ harness: opencode.id, model: ModelId.make(model), effort: "low" });

  it.effect("selects OpenAI for a bare model ID, and the provider that a prefix names", () =>
    Effect.gen(function* () {
      const chosen = yield* Effect.forEach(
        ["gpt-test", "openai/gpt-test", "opencode-go/glm-5.3", "opencode-go/vendor/model"],
        (model) =>
          Effect.map(modelChoice(brain(model)), ({ provider, model: id }) => [provider.id, id]),
      );
      assert.deepStrictEqual(chosen, [
        ["openai", "gpt-test"],
        ["openai", "gpt-test"],
        ["opencode-go", "glm-5.3"],
        ["opencode-go", "vendor/model"],
      ]);
    }),
  );

  it.effect(
    "refuses a provider that the harness doesn't list, with the list, and an empty model",
    () =>
      Effect.gen(function* () {
        const refused = yield* Effect.forEach(
          ["anthropic/claude-test", "/gpt-test", "opencode-go/", "opencode-go/ "],
          (model) => Effect.map(Effect.flip(modelChoice(brain(model))), (error) => error.message),
        );
        assert.deepStrictEqual(refused, [
          'OpenCode has no provider "anthropic" for the model "anthropic/claude-test". Choose one of openai, opencode-go as <provider>/<model>; a model ID without a provider is openai\'s.',
          'OpenCode has no provider "" for the model "/gpt-test". Choose one of openai, opencode-go as <provider>/<model>; a model ID without a provider is openai\'s.',
          'The model "opencode-go/" names no model after its provider',
          'The model "opencode-go/ " names no model after its provider',
        ]);
      }),
  );
});

/** Returns the provider and model that the descriptor selects for `model`. */
const chosen = (model: string) => Result.getOrThrow(opencode.providerOf(ModelId.make(model)));

/** An admission context on `route` for a session on an SSH worker. */
const context = (route: CredentialRoute) =>
  AdmissionContext.make({ placement: "ssh", credential: route });

describe("OpenCode session configuration", () => {
  const decode = Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.StructWithRest(
        Schema.Struct({
          model: Schema.optionalKey(Schema.String),
          providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
          policies: Schema.optionalKey(Schema.Json),
        }),
        [Schema.Record(Schema.String, Schema.Json)],
      ),
    ),
  );

  it.effect(
    "configures OpenCode Go with the caller token at its slot's variable, and keeps every other setting of the OpenAI configuration",
    () =>
      Effect.gen(function* () {
        const configs = yield* Effect.forEach(
          [
            ["gpt-test", OPENCODE_BASE_URL],
            ["opencode-go/glm-5.3", OPENCODE_GO_BASE_URL],
          ] as const,
          ([model, variable]) =>
            serveConfig({
              choice: chosen(model),
              route: "gateway-api-key",
              cwd: "/work/checkout",
              baseUrl: Option.some(variable),
            }).pipe(Effect.flatMap(decode)),
        );
        const [openai, go] = configs;
        assert(openai !== undefined && go !== undefined);
        const { model, providers, policies, ...rest } = go;
        const { model: _model, providers: _providers, policies: _policies, ...kept } = openai;
        assert.deepStrictEqual(rest, kept);
        assert.deepStrictEqual(
          { model, policies, go: providers?.["opencode-go"], openai: providers?.openai },
          {
            model: "opencode-go/glm-5.3",
            policies: [
              { action: "provider.use", resource: "*", effect: "deny" },
              { action: "provider.use", resource: "opencode-go", effect: "allow" },
              { action: "plugin.use", resource: "*", effect: "deny" },
              { action: "mcp.use", resource: "*", effect: "deny" },
              { action: "websearch.use", resource: "*", effect: "deny" },
            ],
            go: {
              env: [],
              settings: {
                apiKey: "{env:USINE_GATEWAY_TOKEN}",
                transport: "http",
                baseURL: "{env:USINE_OPENCODE_GO_BASE_URL}",
              },
            },
            openai: undefined,
          },
        );
        assert.deepStrictEqual(
          Object.keys(providers ?? {}),
          Object.keys(openai.providers ?? {}).map((id) => (id === "openai" ? "opencode-go" : id)),
        );
      }),
  );

  it.effect(
    "reads the base URL of the model's slot on a gateway route, and refuses a provider that the route can't reach",
    () =>
      Effect.gen(function* () {
        const go = chosen("opencode-go/glm-5.3");
        const openai = chosen("gpt-test");
        const goBrain = goRequest.session.brain;
        const slots = {
          [OPENCODE_OPENAI_BASE_URL]: "http://llm.gw.test/openai-responses/v1",
          [OPENCODE_GO_BASE_URL]: "http://llm.gw.test/opencode-go",
        };
        const credentials = yield* Effect.forEach(
          [
            [slots, go, "gateway-api-key"],
            [slots, openai, "gateway"],
            [{ [OPENCODE_BASE_URL]: "https://api.openai.com/v1" }, openai, "api-key"],
            [{}, openai, "api-key"],
          ] as const,
          ([environment, choice, route]) =>
            sessionCredential(environment, goBrain, choice, context(route)),
        );
        assert.deepStrictEqual(credentials, [
          { route: "gateway-api-key", baseUrl: Option.some(OPENCODE_GO_BASE_URL) },
          { route: "gateway", baseUrl: Option.some(OPENCODE_OPENAI_BASE_URL) },
          { route: "api-key", baseUrl: Option.some(OPENCODE_BASE_URL) },
          { route: "api-key", baseUrl: Option.none() },
        ]);
        const unheld = yield* Effect.flip(
          sessionCredential(
            { [OPENCODE_OPENAI_BASE_URL]: "set" },
            goBrain,
            go,
            context("gateway-api-key"),
          ),
        );
        assert.strictEqual(
          unheld.message,
          'The gateway holds no OpenCode Go credential for the model "opencode-go/glm-test". Connect one for opencode-go at the gateway, and list its slot opencode-go in the worker\'s llm_providers.',
        );
        const direct = yield* Effect.flip(
          sessionCredential({ [OPENCODE_GO_BASE_URL]: "set" }, goBrain, go, context("api-key")),
        );
        assert.include(direct.message, "only through a gateway that holds its key");
      }),
  );

  it.effect(
    "uses the attempt's API key on a gateway route whose gateway holds no slot of the model's provider",
    () =>
      Effect.gen(function* () {
        const provisioned = { [OPENCODE_BASE_URL]: "https://api.openai.com/v1" };
        const goBrain = goRequest.session.brain;
        const credential = yield* sessionCredential(
          provisioned,
          goBrain,
          chosen("gpt-test"),
          context("gateway-api-key"),
        );
        assert.deepStrictEqual(credential, {
          route: "api-key",
          baseUrl: Option.some(OPENCODE_BASE_URL),
        });
        const go = yield* Effect.flip(
          sessionCredential(
            provisioned,
            goBrain,
            chosen("opencode-go/glm-5.3"),
            context("gateway-api-key"),
          ),
        );
        assert.strictEqual(
          go.message,
          "OpenCode reaches OpenCode Go models only through a gateway that holds its key, and the api-key route has none",
        );
      }),
  );
});
