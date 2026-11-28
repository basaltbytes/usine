import {
  anthropic,
  ApiKeyCredential,
  SubscriptionCredential,
  GatewaySlot,
  GatewayVariable,
  HeaderName,
  KeyHeader,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  modelProviders,
  openai,
  opencodeGo,
  ProviderProtocol,
  RoutePattern,
  UpstreamBase,
  WireProtocol,
} from "@usine/core/agent/provider";
import { jsonKey } from "@usine/core/json-key";
// The stand-in upstream and the proxy requests need Node's HTTP server and client.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer, request } from "node:http";
import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Predicate,
  Record,
  Redacted,
  Schema,
  Scope,
  Exit,
  Tracer,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AttachRequest, GatewayAdminApi } from "../src/admin/api.ts";
import { AnonymousCredential } from "../src/attachment/attachment.ts";
import { Attachments } from "../src/attachment/store.ts";
import { GatewayAddresses, GatewayReload, gatewayLayer } from "../src/node/node.ts";
import { readSettingsSource, readStartupSettings } from "../src/node/environment.ts";
import { gatewayReloadLayer } from "../src/node/reload.ts";
import { GatewaySettings, SettingsInForce } from "../src/settings.ts";
import { LoginSecret, ProviderCredential, StaticKey } from "../src/credentials/model.ts";
import {
  AnthropicSubscriptionToken,
  ApiKey,
  CHATGPT_UPSTREAM,
  ChatGptLogin,
  LlmProvider,
  type LlmProviders,
} from "../src/llm/llm.ts";
import { ProviderCredentials } from "../src/credentials/store.ts";
import {
  ADMIN_TOKEN_VALUE,
  NO_PROVIDERS,
  REPOSITORY,
  WORKER,
  settingsLayer,
  authFileText,
  chatGptAccessToken,
} from "./fixtures.ts";

const listener = { host: "127.0.0.1", port: 0 };
const upstreamsOf = (providers: LlmProviders) => Record.map(providers, ({ upstream }) => upstream);
const connectedUpstreams = {
  [anthropic.slot]: Option.none(),
  [openai.slot]: Option.some(CHATGPT_UPSTREAM),
};

const PLAN_KEY = "plan-key-for-credential-tests-0123456789";
const ANTHROPIC_KEY = "sk-ant-api03-keyForCredentialTests0123";

const Secret = Schema.Redacted(Schema.NonEmptyString);

/** The admin API's credential payload as gateways up to 0.3.0 decode it. */
const CredentialUpTo030 = Schema.Struct({
  kind: Schema.Literals([
    "claude-subscription",
    "anthropic-api-key",
    "chatgpt-subscription",
    "openai-api-key",
  ]),
  secret: Secret,
});

/** `provider-credentials.json` as gateways up to 0.3.0 decode it. */
const FileUpTo030 = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Record(
      GatewaySlot,
      Schema.Option(
        Schema.Union([
          Schema.TaggedStruct("AnthropicProvider", {
            upstream: UpstreamBase,
            credential: Schema.Union([
              Schema.TaggedStruct("AnthropicApiKey", { key: Secret }),
              AnthropicSubscriptionToken,
            ]),
          }),
          Schema.TaggedStruct("OpenAiProvider", {
            upstream: UpstreamBase,
            credential: Schema.Union([
              Schema.TaggedStruct("OpenAiApiKey", { key: Secret }),
              ChatGptLogin,
            ]),
          }),
        ]),
      ),
    ),
  ),
);

/**
 * A stand-in for a provider's upstream that records the path and the `authorization` or
 * `x-api-key` of each request.
 */
const standIn = Effect.gen(function* () {
  const seen: Array<readonly [string, string]> = [];
  const server = createServer((incoming, response) => {
    const key = incoming.headers.authorization ?? incoming.headers["x-api-key"];
    seen.push([incoming.url ?? "", Predicate.isString(key) ? key : "none"]);
    incoming.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );
  const address = server.address();
  assert(address !== null && !Predicate.isString(address));
  return { origin: `http://127.0.0.1:${address.port}`, seen };
});

/** The gateway variable that replaces the upstream of `planAt`'s provider. */
const PLAN_UPSTREAM = "TEST_PLAN_UPSTREAM";

/**
 * A provider that only this test defines, with a static key, at `origin`. Its slot differs from
 * its ID, so a test sees which one the gateway keys a credential by.
 */
const planAt = (origin: string) =>
  ModelProvider.make({
    id: ModelProviderId.make("test-plan"),
    slot: GatewaySlot.make("test-plan-chat"),
    label: "Test plan",
    protocols: [
      ProviderProtocol.make({
        protocol: WireProtocol.make("openai-chat-completions"),
        upstream: UpstreamBase.make(`${origin}/v1`),
        routes: [RoutePattern.make("/chat/completions")],
        key: KeyHeader.make({ header: HeaderName.make("authorization"), scheme: "bearer" }),
      }),
    ],
    credentials: [ApiKeyCredential.make({ variable: GatewayVariable.make("TEST_PLAN_API_KEY") })],
    upstreamVariable: Option.some(GatewayVariable.make(PLAN_UPSTREAM)),
  });

/** The gateway variable that replaces the upstream of `trailingAt`'s provider. */
const TRAILING_UPSTREAM = "TEST_TRAILING_UPSTREAM";

/** A second provider that only this test defines, with a static key, at `origin`. */
const trailingAt = (origin: string) =>
  ModelProvider.make({
    id: ModelProviderId.make("test-trailing"),
    slot: GatewaySlot.make("test-trailing"),
    label: "Test trailing",
    protocols: [
      ProviderProtocol.make({
        protocol: WireProtocol.make("openai-chat-completions"),
        upstream: UpstreamBase.make(`${origin}/v1`),
        routes: [RoutePattern.make("/chat/completions")],
        key: KeyHeader.make({ header: HeaderName.make("authorization"), scheme: "bearer" }),
      }),
    ],
    credentials: [
      ApiKeyCredential.make({ variable: GatewayVariable.make("TEST_TRAILING_API_KEY") }),
    ],
    upstreamVariable: Option.some(GatewayVariable.make(TRAILING_UPSTREAM)),
  });

/** A report of `GET /v1/provider-credentials` as orchestrators up to 0.6.0 decode it. */
const ConnectionsUpTo060 = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        provider: Schema.Literals(["anthropic-messages", "openai-responses"]),
        credential: Schema.NullOr(Schema.Literals(["api-key", "subscription"])),
        expiresAt: Schema.NullOr(Schema.String),
        lastRefresh: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);

/**
 * The gateway as `usine-gateway` composes it, serving `catalog`, with its settings from the
 * environment and `variables`, and its state in `directory`.
 */
const gatewayServing = (
  catalog: ModelProviderCatalog,
  directory: string,
  variables: Readonly<Record<string, string>> = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const base = ConfigProvider.fromEnv({
        env: {
          ...variables,
          USINE_GATEWAY_DOMAIN: "gw.test",
          USINE_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN_VALUE,
          USINE_GATEWAY_CALLER_KEY: "caller-key-for-credential-tests-0123456789",
          USINE_GATEWAY_PROXY_PORT: "0",
          USINE_GATEWAY_EGRESS_PORT: "0",
          USINE_GATEWAY_ADMIN_PORT: "0",
          USINE_GATEWAY_EGRESS_ALLOWLIST: `${directory}/egress-allowlist`,
        },
      });
      const source = yield* readSettingsSource(base);
      const started = yield* readStartupSettings(source, catalog);
      return gatewayReloadLayer(started, base).pipe(
        Layer.provide(NodeCrypto.layer),
        Layer.provideMerge(gatewayLayer(started.listeners, Attachments.layer, directory)),
        Layer.provide(Layer.succeed(GatewaySettings)(started.settings)),
      );
    }),
  );

/** Returns the admin API client of the gateway in `context`. */
const adminOf = (context: Context.Context<GatewayAddresses>) =>
  Effect.gen(function* () {
    const { admin } = Context.get(context, GatewayAddresses);
    return yield* HttpApiClient.make(GatewayAdminApi, {
      baseUrl: `http://${admin.host}:${admin.port}`,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(ADMIN_TOKEN_VALUE)),
    });
  });

/**
 * Attaches the test repository on the gateway in `context`, then returns a request from the
 * attempt to `path` on `llm.gw.test`, which resolves to the response status.
 */
const attemptOn = (context: Context.Context<GatewayAddresses>) =>
  Effect.gen(function* () {
    const client = yield* adminOf(context);
    const now = yield* DateTime.now;
    const { callerToken } = yield* client.attachments.attach({
      payload: AttachRequest.make({
        worker: WORKER,
        repository: REPOSITORY,
        credential: AnonymousCredential.make(),
        expiresAt: DateTime.add(now, { minutes: 60 }),
      }),
    });
    const { proxy } = Context.get(context, GatewayAddresses);
    return (path: string) =>
      Effect.callback<number>((resume) => {
        const outgoing = request(
          {
            host: proxy.host,
            port: proxy.port,
            method: "POST",
            path,
            headers: {
              host: "llm.gw.test",
              authorization: `Bearer ${Redacted.value(callerToken)}`,
              "content-type": "application/json",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => resume(Effect.succeed(response.statusCode ?? 0)));
          },
        );
        outgoing.once("error", (error) => resume(Effect.die(error)));
        outgoing.end('{"model":"plan-model"}');
      });
  });

it.live(
  "persists admin credential handoffs, applies them after restart, and exposes only metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const lines: string[] = [];
        const logs = Logger.layer([
          Logger.make(({ message }) => {
            lines.push(jsonKey(message));
          }),
        ]);
        const start = () =>
          gatewayLayer(
            { proxy: listener, egress: listener, admin: listener },
            undefined,
            directory,
          ).pipe(Layer.provide(settingsLayer(NO_PROVIDERS)), Layer.provide(logs));
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(start(), scope);
        const client = yield* adminOf(context);
        const claudeSecret = "sk-ant-oat01-private-fixture";
        yield* client.llm.connect({
          payload: LoginSecret.make({ login: "claude", secret: Redacted.make(claudeSecret) }),
        });
        const now = yield* DateTime.now;
        const expiry = DateTime.add(now, { hours: 1 });
        const auth = authFileText({
          access: chatGptAccessToken(expiry),
          refresh: "refresh-private-fixture",
        });
        yield* client.llm.connect({
          payload: LoginSecret.make({ login: "chatgpt", secret: Redacted.make(auth) }),
        });
        const malformed = yield* client.llm
          .connect({
            payload: LoginSecret.make({
              login: "chatgpt",
              secret: Redacted.make("private-malformed-auth"),
            }),
          })
          .pipe(Effect.flip);
        assert.notInclude(jsonKey(malformed), "private-malformed-auth");
        const state = yield* client.llm.connections();
        assert.deepEqual(
          state.providers.map(({ provider }) => provider),
          ["anthropic-messages", "openai-responses"],
        );
        assert.deepEqual(
          state.providers.map(({ credential }) => credential),
          ["subscription", "subscription"],
        );
        assert.deepEqual(state.providers[0], {
          provider: GatewaySlot.make("anthropic-messages"),
          id: anthropic.id,
          label: "Anthropic",
          accepts: { apiKey: true, login: "claude" },
          credential: "subscription",
          expiresAt: null,
          lastRefresh: null,
          refreshable: false,
        });
        assert.isTrue(state.providers[1]?.refreshable);
        assert.equal(state.providers[1]?.lastRefresh, "2026-10-01T00:00:00.000Z");
        assert.equal(
          state.providers[1]?.expiresAt,
          DateTime.formatIso(expiry).replace(/\.\d{3}Z$/u, ".000Z"),
        );
        const listed = yield* client.llm.providers();
        const exposed = jsonKey(state) + jsonKey(listed) + lines.join("\n");
        assert.notInclude(exposed, claudeSecret);
        assert.notInclude(exposed, "refresh-private-fixture");
        assert.notInclude(exposed, "access_token");
        const persisted = yield* fs.stat(`${directory}/provider-credentials.json`);
        assert.equal(persisted.mode & 0o777, 0o600);
        const current = yield* SettingsInForce.pipe(Effect.provideContext(context));
        assert.deepStrictEqual(upstreamsOf((yield* current.current).providers), connectedUpstreams);
        yield* Scope.close(scope, Exit.void);
        const restarted = yield* Layer.build(start());
        const found = yield* Effect.serviceOption(ProviderCredentials).pipe(
          Effect.provideContext(restarted),
        );
        if (Option.isNone(found)) return yield* Effect.die("Provider credential service missing");
        const credentials = found.value;
        assert.deepEqual(
          (yield* credentials.status).map(({ credential }) => credential),
          ["subscription", "subscription", null],
        );
        assert.deepEqual(
          (yield* credentials.status).map(({ refreshable }) => refreshable),
          [false, true, false],
        );
        const beforeDisconnect = yield* SettingsInForce.pipe(
          Effect.provideContext(restarted),
          Effect.flatMap((settings) => settings.current),
        );
        assert.deepStrictEqual(upstreamsOf(beforeDisconnect.providers), connectedUpstreams);
        yield* credentials.disconnect("anthropic-messages");
        yield* credentials.disconnect("openai");
        assert.deepEqual(
          (yield* credentials.status).map(({ credential }) => credential),
          [null, null, null],
        );
        const next = yield* credentials.apply(
          beforeDisconnect.providers,
          beforeDisconnect.upstreams,
        );
        assert.deepStrictEqual(next, {});
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live(
  "connects a static key for a provider that only the test's catalog has: requests leave with it through a reload and a restart, until it's disconnected",
  () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${directory}/egress-allowlist`, "registry.npmjs.org\n");
        const upstream = yield* standIn;
        const catalogUpstream = yield* standIn;
        const anthropicUpstream = yield* standIn;
        const trailingUpstream = yield* standIn;
        const plan = planAt(catalogUpstream.origin);
        // The provider after the test's has an upstream override too, so the key goes to the
        // override of its own slot, not to the last one.
        const catalog = ModelProviderCatalog.make({
          providers: [...modelProviders.providers, plan, trailingAt(catalogUpstream.origin)],
        });
        const lines: string[] = [];
        const logs = Logger.layer([
          Logger.make(({ message }) => {
            lines.push(jsonKey(message));
          }),
        ]);
        const start = gatewayServing(catalog, directory, {
          [PLAN_UPSTREAM]: `${upstream.origin}/v1`,
          [TRAILING_UPSTREAM]: `${trailingUpstream.origin}/v1`,
          USINE_GATEWAY_ANTHROPIC_UPSTREAM: anthropicUpstream.origin,
        }).pipe(Layer.provide(logs));
        const scope = yield* Scope.make();
        const first = yield* Layer.buildWithScope(start, scope);
        const client = yield* adminOf(first);
        yield* client.llm.connect({
          payload: StaticKey.make({ provider: plan.id, secret: Redacted.make(PLAN_KEY) }),
        });
        const unserved = yield* client.llm
          .connect({
            payload: StaticKey.make({
              provider: ModelProviderId.make("unknown-plan"),
              secret: Redacted.make(PLAN_KEY),
            }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(unserved._tag, "UnservedProvider");
        const report = yield* client.llm.connections();
        const providers = report.catalog ?? [];
        assert.deepStrictEqual(providers.at(-2), {
          provider: plan.slot,
          id: plan.id,
          label: "Test plan",
          accepts: { apiKey: true, login: null },
          credential: "api-key",
          expiresAt: null,
          lastRefresh: null,
          refreshable: false,
        });
        const { admin } = Context.get(first, GatewayAddresses);
        const legacy = yield* HttpClient.get(
          `http://${admin.host}:${admin.port}/v1/provider-credentials`,
          { headers: { authorization: `Bearer ${ADMIN_TOKEN_VALUE}` } },
        ).pipe(
          Effect.flatMap((response) => response.text),
          Effect.flatMap(Schema.decodeUnknownEffect(ConnectionsUpTo060)),
        );
        assert.deepStrictEqual(
          legacy.providers.map(({ provider }): string => provider),
          [anthropic.slot, openai.slot],
        );
        const Saved = Schema.fromJsonString(
          Schema.Struct({
            staticKeys: Schema.Record(
              Schema.String,
              Schema.Struct({ provider: Schema.String, key: Schema.String }),
            ),
          }),
        );
        const saved = yield* fs
          .readFileString(`${directory}/provider-credentials.json`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Saved)));
        assert.deepStrictEqual(
          Record.map(saved.staticKeys, ({ provider }) => provider),
          {
            [plan.slot]: plan.id,
          },
        );
        const ask = yield* attemptOn(first);
        const path = `/${plan.slot}/chat/completions`;
        const connected = yield* ask(path);
        yield* Effect.flatMap(GatewayReload, ({ reload }) => reload).pipe(
          Effect.provideContext(first),
        );
        const reloaded = yield* ask(path);
        yield* Scope.close(scope, Exit.void);

        const restarted = yield* Layer.build(start);
        const askAgain = yield* attemptOn(restarted);
        const afterRestart = yield* askAgain(path);
        const again = yield* adminOf(restarted);
        yield* again.llm.disconnect({ params: { provider: plan.id } });
        const afterDisconnect = yield* askAgain(path);
        assert.deepStrictEqual(
          [connected, reloaded, afterRestart, afterDisconnect],
          [200, 200, 200, 503],
        );
        const disconnected = yield* again.llm.connections();
        assert.strictEqual(disconnected.catalog?.at(-2)?.credential, null);

        assert.deepStrictEqual(upstream.seen, [
          ["/v1/chat/completions", `Bearer ${PLAN_KEY}`],
          ["/v1/chat/completions", `Bearer ${PLAN_KEY}`],
          ["/v1/chat/completions", `Bearer ${PLAN_KEY}`],
        ]);
        assert.deepStrictEqual(catalogUpstream.seen, []);
        assert.deepStrictEqual(anthropicUpstream.seen, []);
        assert.deepStrictEqual(trailingUpstream.seen, []);
        assert.isTrue(spans.some(({ name }) => name === "ProviderCredentials.replace"));
        const exposed =
          jsonKey(providers) +
          jsonKey(disconnected) +
          jsonKey(unserved) +
          lines.join("\n") +
          jsonKey(spans.map((span) => [...span.attributes]));
        assert.notInclude(exposed, PLAN_KEY);
      }),
    ).pipe(
      Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
      Effect.provideService(Tracer.Tracer, tracer),
    );
  },
);

it.live(
  "sends each connected built-in static key and the Claude token to the upstream that the environment sets for its slot, through a reload and a restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${directory}/egress-allowlist`, "registry.npmjs.org\n");
        const anthropicUpstream = yield* standIn;
        const openaiUpstream = yield* standIn;
        const start = gatewayServing(modelProviders, directory, {
          USINE_GATEWAY_ANTHROPIC_UPSTREAM: anthropicUpstream.origin,
          USINE_GATEWAY_OPENAI_UPSTREAM: openaiUpstream.origin,
        });
        const messages = `/${anthropic.slot}/v1/messages`;
        const responses = `/${openai.slot}/v1/responses`;
        const openaiKey = "sk-proj-connected-key-for-upstream-tests";
        const claudeToken = "sk-ant-oat01-upstream-private-fixture";
        /** Returns the status of each request through `context` after a reload of it. */
        const askThroughReload = (
          context: Context.Context<GatewayAddresses | GatewayReload>,
          paths: ReadonlyArray<string>,
        ) =>
          Effect.gen(function* () {
            const ask = yield* attemptOn(context);
            const before = yield* Effect.forEach(paths, ask);
            yield* Effect.flatMap(GatewayReload, ({ reload }) => reload).pipe(
              Effect.provideContext(context),
            );
            return [...before, ...(yield* Effect.forEach(paths, ask))];
          });

        const keyed = yield* Scope.make();
        const first = yield* Layer.buildWithScope(start, keyed);
        const client = yield* adminOf(first);
        yield* client.llm.connect({
          payload: StaticKey.make({ provider: anthropic.id, secret: Redacted.make(ANTHROPIC_KEY) }),
        });
        yield* client.llm.connect({
          payload: StaticKey.make({ provider: openai.id, secret: Redacted.make(openaiKey) }),
        });
        const withKeys = yield* askThroughReload(first, [messages, responses]);
        yield* Scope.close(keyed, Exit.void);

        const token = yield* Scope.make();
        const second = yield* Layer.buildWithScope(start, token);
        const afterRestart = yield* askThroughReload(second, [messages, responses]);
        yield* (yield* adminOf(second)).llm.connect({
          payload: LoginSecret.make({ login: "claude", secret: Redacted.make(claudeToken) }),
        });
        const withToken = yield* askThroughReload(second, [messages]);
        yield* Scope.close(token, Exit.void);

        const third = yield* Layer.build(start);
        const tokenAfterRestart = yield* askThroughReload(third, [messages]);

        assert.deepStrictEqual(
          [...withKeys, ...afterRestart, ...withToken, ...tokenAfterRestart],
          Array.from({ length: 12 }, () => 200),
        );
        const anthropicKey = ["/v1/messages", ANTHROPIC_KEY] as const;
        const tokenSent = ["/v1/messages", `Bearer ${claudeToken}`] as const;
        assert.deepStrictEqual(anthropicUpstream.seen, [
          ...Array.from({ length: 4 }, () => anthropicKey),
          ...Array.from({ length: 4 }, () => tokenSent),
        ]);
        assert.deepStrictEqual(
          openaiUpstream.seen,
          Array.from({ length: 4 }, () => ["/v1/responses", `Bearer ${openaiKey}`] as const),
        );
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live(
  "reads a file from gateways up to 0.3.0 and writes one they read, with the other providers' keys aside",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const file = `${directory}/provider-credentials.json`;
        const upTo030 = yield* Schema.encodeEffect(FileUpTo030)({
          [anthropic.slot]: Option.some({
            _tag: "AnthropicProvider",
            upstream: anthropic.protocols[0].upstream,
            credential: { _tag: "AnthropicApiKey", key: Redacted.make(ANTHROPIC_KEY) },
          }),
          [openai.slot]: Option.none(),
        });
        yield* fs.writeFileString(file, upTo030);
        const plan = planAt("https://plan.test");
        const catalog = ModelProviderCatalog.make({
          providers: [...modelProviders.providers, plan],
        });
        const fromEnvironment = LlmProvider.make({
          upstream: Option.none(),
          credential: ApiKey.make({ key: Redacted.make("sk-proj-environment-key") }),
        });
        const start = () =>
          gatewayLayer(
            { proxy: listener, egress: listener, admin: listener },
            undefined,
            directory,
          ).pipe(
            Layer.provide(
              settingsLayer({ [openai.slot]: fromEnvironment }, undefined, undefined, catalog),
            ),
          );
        const storeOf = (context: Context.Context<GatewayAddresses>) =>
          Effect.flatMap(
            Effect.serviceOption(ProviderCredentials).pipe(Effect.provideContext(context)),
            Option.match({
              onNone: () => Effect.die("The gateway has no provider credential store"),
              onSome: Effect.succeed,
            }),
          );
        const kinds = (context: Context.Context<GatewayAddresses>) =>
          Effect.flatMap(storeOf(context), ({ status }) =>
            Effect.map(status, (providers) =>
              providers.map(({ provider, credential }) => [provider, credential]),
            ),
          );
        const scope = yield* Scope.make();
        const first = yield* Layer.buildWithScope(start(), scope);
        const loaded = yield* kinds(first);
        assert.deepStrictEqual(loaded, [
          [anthropic.slot, "api-key"],
          [openai.slot, null],
          [opencodeGo.slot, null],
          [plan.slot, null],
        ]);
        const store = yield* storeOf(first);
        yield* store.replace(
          StaticKey.make({ provider: plan.id, secret: Redacted.make(PLAN_KEY) }),
        );
        yield* store.replace(
          StaticKey.make({ provider: openai.id, secret: Redacted.make("sk-proj-connected-key") }),
        );
        const text = yield* fs.readFileString(file);
        const written = yield* Schema.decodeEffect(FileUpTo030)(text);
        assert.deepStrictEqual(
          Record.map(written, (held) =>
            Option.map(held, ({ _tag, credential }) => [_tag, credential._tag]),
          ),
          {
            [anthropic.slot]: Option.some(["AnthropicProvider", "AnthropicApiKey"]),
            [openai.slot]: Option.some(["OpenAiProvider", "OpenAiApiKey"]),
          },
        );
        yield* Scope.close(scope, Exit.void);

        const restarted = yield* Layer.build(start());
        const reread = yield* kinds(restarted);
        assert.deepStrictEqual(reread, [
          [anthropic.slot, "api-key"],
          [openai.slot, "api-key"],
          [opencodeGo.slot, null],
          [plan.slot, "api-key"],
        ]);
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.effect("encodes each built-in credential with the kind that gateways up to 0.3.0 accept", () =>
  Effect.gen(function* () {
    const secret = Redacted.make("private-fixture");
    const credentials = [
      LoginSecret.make({ login: "claude", secret }),
      StaticKey.make({ provider: anthropic.id, secret }),
      LoginSecret.make({ login: "chatgpt", secret }),
      StaticKey.make({ provider: openai.id, secret }),
    ];
    const kinds = yield* Effect.forEach(credentials, (credential) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(ProviderCredential)(credential);
        assert.isTrue(Schema.is(CredentialUpTo030)(encoded));
        const decoded = yield* Schema.decodeEffect(ProviderCredential)(encoded);
        assert.deepStrictEqual(decoded, credential);
        return [encoded.kind, Option.getOrNull(credential.providerIn(modelProviders))?.slot];
      }),
    );
    assert.deepStrictEqual(kinds, [
      ["claude-subscription", anthropic.slot],
      ["anthropic-api-key", anthropic.slot],
      ["chatgpt-subscription", openai.slot],
      ["openai-api-key", openai.slot],
    ]);
  }),
);

it.live(
  "loads a saved static key without a provider ID, and ignores one connected for another provider than its slot's, with a warning",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const warnings: string[] = [];
        const logs = Logger.layer([
          Logger.make(({ logLevel, message }) => {
            if (logLevel === "Warn") warnings.push(jsonKey(message));
          }),
        ]);
        const plan = planAt("https://plan.test");
        const trailing = trailingAt("https://trailing.test");
        const trailingKey = "trailing-key-for-credential-tests-0123456789";
        // The slot's key was connected for a provider that a later catalog moved out of the slot.
        yield* fs.writeFileString(
          `${directory}/provider-credentials.json`,
          jsonKey({
            staticKeys: {
              [plan.slot]: { provider: "earlier-plan", key: PLAN_KEY },
              [trailing.slot]: trailingKey,
            },
          }),
        );
        const started = yield* Layer.build(
          gatewayLayer(
            { proxy: listener, egress: listener, admin: listener },
            undefined,
            directory,
          ).pipe(
            Layer.provide(
              settingsLayer(
                NO_PROVIDERS,
                undefined,
                undefined,
                ModelProviderCatalog.make({ providers: [anthropic, plan, trailing] }),
              ),
            ),
            Layer.provide(logs),
          ),
        );
        const { providers } = yield* SettingsInForce.pipe(
          Effect.provideContext(started),
          Effect.flatMap((settings) => settings.current),
        );
        assert.deepStrictEqual(Object.keys(providers), [trailing.slot]);
        const held = providers[trailing.slot];
        assert(held !== undefined && held.credential._tag === "ApiKey");
        assert.strictEqual(Redacted.value(held.credential.key), trailingKey);
        const ignored = warnings.filter((line) =>
          line.includes("Ignored a stored static key connected for another provider"),
        );
        assert.strictEqual(ignored.length, 1);
        assert.include(ignored[0], `"slot":"${plan.slot}"`);
        assert.include(ignored[0], '"provider":"earlier-plan"');
        assert.include(ignored[0], `"slotProvider":"${plan.id}"`);
        assert.notInclude(warnings.join("\n"), PLAN_KEY);
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live(
  "ignores a stored credential under a slot whose provider doesn't accept it, and logs it without its value",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const file = `${directory}/provider-credentials.json`;
        const warnings: string[] = [];
        const logs = Logger.layer([
          Logger.make(({ logLevel, message }) => {
            if (logLevel === "Warn") warnings.push(jsonKey(message));
          }),
        ]);
        const start = (catalog: ModelProviderCatalog = modelProviders) =>
          gatewayLayer(
            { proxy: listener, egress: listener, admin: listener },
            undefined,
            directory,
          ).pipe(
            Layer.provide(settingsLayer(NO_PROVIDERS, undefined, undefined, catalog)),
            Layer.provide(logs),
          );
        const secret = "sk-ant-api03-misplaced-private-fixture";
        const first = yield* Scope.make();
        const connected = yield* Layer.buildWithScope(start(), first);
        const credentials = yield* Effect.serviceOption(ProviderCredentials).pipe(
          Effect.provideContext(connected),
        );
        if (Option.isNone(credentials))
          return yield* Effect.die("Provider credential service missing");
        yield* credentials.value.replace(
          StaticKey.make({ provider: anthropic.id, secret: Redacted.make(secret) }),
        );
        yield* Scope.close(first, Exit.void);

        const StoredFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
        const stored = yield* fs
          .readFileString(file)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(StoredFile)));
        const record = stored[anthropic.slot];
        assert(record !== undefined);
        // The test's provider now takes only the ChatGPT login, in place of OpenAI, so its saved static key no longer applies.
        const plan = planAt("https://plan.test");
        const loginOnly = ModelProvider.make({
          id: plan.id,
          slot: plan.slot,
          label: plan.label,
          protocols: plan.protocols,
          credentials: [
            SubscriptionCredential.make({
              login: "chatgpt",
              variable: GatewayVariable.make("TEST_PLAN_AUTH_FILE"),
            }),
          ],
        });
        const misplaced = {
          [anthropic.slot]: record,
          [openai.slot]: record,
          "test-plan": record,
          staticKeys: { [plan.slot]: PLAN_KEY },
        };
        const text = yield* Schema.encodeEffect(StoredFile)(misplaced);
        yield* fs.writeFileString(file, text);
        const restarted = yield* Layer.build(
          start(ModelProviderCatalog.make({ providers: [anthropic, loginOnly] })),
        );
        const { providers } = yield* SettingsInForce.pipe(
          Effect.provideContext(restarted),
          Effect.flatMap((settings) => settings.current),
        );
        assert.deepStrictEqual(Object.keys(providers), [anthropic.slot]);
        const ignored = warnings.filter((line) => line.includes("Ignored a stored provider"));
        assert.strictEqual(ignored.length, 2);
        assert.include(ignored[0], `"slot":"${openai.slot}"`);
        assert.include(ignored[0], '"kind":"AnthropicProvider"');
        assert.include(ignored[1], '"slot":"test-plan"');
        const ignoredKeys = warnings.filter((line) => line.includes("Ignored a stored static key"));
        assert.strictEqual(ignoredKeys.length, 1);
        assert.include(ignoredKeys[0], `"slot":"${plan.slot}"`);
        const store = yield* Effect.serviceOption(ProviderCredentials).pipe(
          Effect.provideContext(restarted),
        );
        if (Option.isNone(store)) return yield* Effect.die("Provider credential service missing");
        const listed = yield* store.value.status;
        assert.deepStrictEqual(
          listed
            .filter(({ provider }) => provider === plan.slot)
            .map(({ accepts, credential }) => [accepts.apiKey, credential]),
          [[false, null]],
        );
        const refused = yield* store.value
          .replace(StaticKey.make({ provider: plan.id, secret: Redacted.make(PLAN_KEY) }))
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "UnservedProvider");
        // Anthropic now takes only the Claude login, so its saved static key no longer applies.
        const claudeOnly = ModelProvider.make({
          id: anthropic.id,
          slot: anthropic.slot,
          label: anthropic.label,
          protocols: anthropic.protocols,
          credentials: [
            SubscriptionCredential.make({
              login: "claude",
              variable: GatewayVariable.make("USINE_GATEWAY_ANTHROPIC_SUBSCRIPTION_TOKEN"),
            }),
          ],
          upstreamVariable: anthropic.upstreamVariable,
        });
        const loginOnlyAnthropic = yield* Layer.build(
          start(ModelProviderCatalog.make({ providers: [claudeOnly] })),
        );
        const withoutKey = yield* SettingsInForce.pipe(
          Effect.provideContext(loginOnlyAnthropic),
          Effect.flatMap((settings) => settings.current),
        );
        assert.deepStrictEqual(Object.keys(withoutKey.providers), []);
        const ignoredKey = warnings.filter(
          (line) =>
            line.includes("Ignored a stored provider") &&
            line.includes(`"slot":"${anthropic.slot}"`),
        );
        assert.strictEqual(ignoredKey.length, 1);
        assert.notInclude(warnings.join("\n"), secret);
        assert.notInclude(warnings.join("\n"), PLAN_KEY);
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live(
  "keeps a login across a restart when the catalog's provider that signs in with it has a slot of its own",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const claude = ModelProvider.make({
          id: anthropic.id,
          slot: GatewaySlot.make("claude-messages"),
          label: anthropic.label,
          protocols: anthropic.protocols,
          credentials: anthropic.credentials,
          upstreamVariable: anthropic.upstreamVariable,
        });
        const catalog = ModelProviderCatalog.make({ providers: [claude, openai] });
        const start = () =>
          gatewayLayer(
            { proxy: listener, egress: listener, admin: listener },
            undefined,
            directory,
          ).pipe(Layer.provide(settingsLayer(NO_PROVIDERS, undefined, undefined, catalog)));
        const storeOf = (context: Context.Context<GatewayAddresses>) =>
          Effect.flatMap(
            Effect.serviceOption(ProviderCredentials).pipe(Effect.provideContext(context)),
            Option.match({
              onNone: () => Effect.die("The gateway has no provider credential store"),
              onSome: Effect.succeed,
            }),
          );
        const kinds = (context: Context.Context<GatewayAddresses>) =>
          Effect.flatMap(storeOf(context), ({ status }) =>
            Effect.map(status, (providers) =>
              providers.map(({ provider, credential }) => [provider, credential]),
            ),
          );
        const scope = yield* Scope.make();
        const first = yield* Layer.buildWithScope(start(), scope);
        yield* Effect.flatMap(storeOf(first), ({ replace }) =>
          replace(
            LoginSecret.make({ login: "claude", secret: Redacted.make("sk-ant-oat01-private") }),
          ),
        );
        const connected = yield* kinds(first);
        yield* Scope.close(scope, Exit.void);
        const again = yield* Layer.build(start());
        const restarted = yield* kinds(again);
        assert.deepStrictEqual(
          [connected, restarted],
          [
            [
              [claude.slot, "subscription"],
              [openai.slot, null],
            ],
            [
              [claude.slot, "subscription"],
              [openai.slot, null],
            ],
          ],
        );
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

/** Builds the gateway over `catalog`, with its provider credentials in `directory`. */
const gatewayOver = (
  directory: string,
  catalog: ModelProviderCatalog,
  logs: Layer.Layer<never> = Layer.empty,
) =>
  gatewayLayer({ proxy: listener, egress: listener, admin: listener }, undefined, directory).pipe(
    Layer.provide(settingsLayer(NO_PROVIDERS, undefined, undefined, catalog)),
    Layer.provide(logs),
  );

/** Returns the provider credential store of a built gateway. */
const credentialStoreOf = (context: Context.Context<GatewayAddresses>) =>
  Effect.flatMap(
    Effect.serviceOption(ProviderCredentials).pipe(Effect.provideContext(context)),
    Option.match({
      onNone: () => Effect.die("The gateway has no provider credential store"),
      onSome: Effect.succeed,
    }),
  );

/** Returns each slot of a built gateway's settings in force, with its credential's kind. */
const slotsOf = (context: Context.Context<SettingsInForce>) =>
  SettingsInForce.pipe(
    Effect.provideContext(context),
    Effect.flatMap((settings) => settings.current),
    Effect.map(({ providers }) =>
      Object.entries(providers).map(([slot, { credential }]) => [slot, credential._tag]),
    ),
  );

/** Returns a logger layer that collects the message of each warning in `warnings`. */
const warningsInto = (warnings: string[]) =>
  Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(jsonKey(message));
    }),
  ]);

/** Returns a provider with the ID `impostor` that takes a static key in `slot`. */
const impostorIn = (slot: GatewaySlot) =>
  ModelProvider.make({
    ...planAt("https://impostor.test"),
    id: ModelProviderId.make("impostor"),
    slot,
  });

const BUILT_IN_KEYS = [
  { builtIn: anthropic, key: ANTHROPIC_KEY, kind: "AnthropicProvider" },
  { builtIn: openai, key: "sk-proj-built-in-slot-private-fixture", kind: "OpenAiProvider" },
];

it.live.each(BUILT_IN_KEYS)(
  "ignores $builtIn.id's stored key once another provider holds its slot",
  ({ builtIn, key, kind }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const warnings: string[] = [];
        const first = yield* Scope.make();
        const connected = yield* Layer.buildWithScope(
          gatewayOver(directory, modelProviders),
          first,
        );
        yield* Effect.flatMap(credentialStoreOf(connected), ({ replace }) =>
          replace(StaticKey.make({ provider: builtIn.id, secret: Redacted.make(key) })),
        );
        yield* Scope.close(first, Exit.void);
        const impostors = ModelProviderCatalog.make({ providers: [impostorIn(builtIn.slot)] });
        const restarted = yield* Layer.build(
          gatewayOver(directory, impostors, warningsInto(warnings)),
        );
        const slots = yield* slotsOf(restarted);

        assert.deepStrictEqual(slots, []);
        const ignored = warnings.filter((line) => line.includes("Ignored a stored"));
        assert.strictEqual(ignored.length, 1);
        assert.include(ignored[0], `"kind":"${kind}"`);
        assert.notInclude(warnings.join("\n"), key);
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live.each(BUILT_IN_KEYS)(
  "keeps another provider's key in $builtIn.id's slot for that provider only",
  ({ builtIn }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const warnings: string[] = [];
        const impostor = impostorIn(builtIn.slot);
        const impostors = ModelProviderCatalog.make({ providers: [impostor] });
        const taken = yield* Scope.make();
        const takenOver = yield* Layer.buildWithScope(gatewayOver(directory, impostors), taken);
        yield* Effect.flatMap(credentialStoreOf(takenOver), ({ replace }) =>
          replace(StaticKey.make({ provider: impostor.id, secret: Redacted.make(PLAN_KEY) })),
        );
        yield* Scope.close(taken, Exit.void);
        const file = yield* fs.readFileString(`${directory}/provider-credentials.json`);

        const impostorAgain = yield* Layer.build(gatewayOver(directory, impostors)).pipe(
          Effect.flatMap(slotsOf),
        );
        const builtInAgain = yield* Layer.build(
          gatewayOver(directory, modelProviders, warningsInto(warnings)),
        ).pipe(Effect.flatMap(slotsOf));
        assert.deepStrictEqual([impostorAgain, builtInAgain], [[[builtIn.slot, "ApiKey"]], []]);
        assert.include(file, '"staticKeys"');
        assert.include(file, '"provider":"impostor"');
        assert.notInclude(file, '"AnthropicProvider"');
        assert.notInclude(file, '"OpenAiProvider"');
        const ignored = warnings.filter((line) => line.includes("Ignored a stored"));
        assert.strictEqual(ignored.length, 1);
        assert.include(ignored[0], '"provider":"impostor"');
        assert.include(ignored[0], `"slotProvider":"${builtIn.id}"`);
        assert.notInclude(warnings.join("\n"), PLAN_KEY);
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it.live(
  "keeps a Claude login for the anthropic provider once another provider signs in with it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const warnings: string[] = [];
        const impostor = ModelProvider.make({
          ...impostorIn(anthropic.slot),
          credentials: [
            ApiKeyCredential.make({ variable: GatewayVariable.make("TEST_PLAN_API_KEY") }),
            SubscriptionCredential.make({
              login: "claude",
              variable: GatewayVariable.make("TEST_PLAN_SUBSCRIPTION_TOKEN"),
            }),
          ],
        });
        const impostors = ModelProviderCatalog.make({ providers: [impostor] });
        const claudeToken = "sk-ant-oat01-impostor-private-fixture";
        const builtIn = yield* Scope.make();
        const connected = yield* Layer.buildWithScope(
          gatewayOver(directory, modelProviders),
          builtIn,
        );
        yield* Effect.flatMap(credentialStoreOf(connected), ({ replace }) =>
          replace(LoginSecret.make({ login: "claude", secret: Redacted.make(claudeToken) })),
        );
        yield* Scope.close(builtIn, Exit.void);

        // The impostor signs in with the Claude login in Anthropic's slot, so the token stays unused.
        const takenOver = yield* Layer.build(
          gatewayOver(directory, impostors, warningsInto(warnings)),
        );
        const atTakeover = yield* slotsOf(takenOver);
        const refused = yield* Effect.flatMap(credentialStoreOf(takenOver), ({ replace }) =>
          replace(LoginSecret.make({ login: "claude", secret: Redacted.make(claudeToken) })),
        ).pipe(Effect.flip);

        assert.deepStrictEqual([atTakeover, refused._tag], [[], "UnservedProvider"]);
        const ignored = warnings.filter((line) => line.includes("Ignored a stored"));
        assert.strictEqual(ignored.length, 1);
        assert.include(ignored[0], '"kind":"AnthropicProvider"');
        assert.notInclude(warnings.join("\n"), claudeToken);
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);
