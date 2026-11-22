import {
  anthropic,
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  HeaderName,
  KeyHeader,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  modelProviders,
  openai,
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
  [anthropic.slot]: Option.some(anthropic.protocols[0].upstream),
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

/** A stand-in for a provider's upstream that records the path and `authorization` of each request. */
const standIn = Effect.gen(function* () {
  const seen: Array<readonly [string, string]> = [];
  const server = createServer((incoming, response) => {
    seen.push([incoming.url ?? "", incoming.headers.authorization ?? "none"]);
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

/** A provider that only this test defines, with a static key, at `origin`. */
const planAt = (origin: string) =>
  ModelProvider.make({
    id: ModelProviderId.make("test-plan"),
    slot: GatewaySlot.make("test-plan"),
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
  });

/**
 * The gateway as `usine-gateway` composes it, serving `catalog`, with its settings from the
 * environment and its state in `directory`.
 */
const gatewayServing = (catalog: ModelProviderCatalog, directory: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const base = ConfigProvider.fromEnv({
        env: {
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
          ["subscription", "subscription"],
        );
        assert.deepEqual(
          (yield* credentials.status).map(({ refreshable }) => refreshable),
          [false, true],
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
          [null, null],
        );
        const next = yield* credentials.apply(beforeDisconnect.providers);
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
        const plan = planAt(upstream.origin);
        const catalog = ModelProviderCatalog.make({
          providers: [...modelProviders.providers, plan],
        });
        const lines: string[] = [];
        const logs = Logger.layer([
          Logger.make(({ message }) => {
            lines.push(jsonKey(message));
          }),
        ]);
        const start = gatewayServing(catalog, directory).pipe(Layer.provide(logs));
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
        const { providers } = yield* client.llm.connections();
        assert.deepStrictEqual(providers.at(-1), {
          provider: plan.slot,
          id: plan.id,
          label: "Test plan",
          accepts: { apiKey: true, login: null },
          credential: "api-key",
          expiresAt: null,
          lastRefresh: null,
          refreshable: false,
        });
        const ask = yield* attemptOn(first);
        const connected = yield* ask("/test-plan/chat/completions");
        yield* Effect.flatMap(GatewayReload, ({ reload }) => reload).pipe(
          Effect.provideContext(first),
        );
        const reloaded = yield* ask("/test-plan/chat/completions");
        yield* Scope.close(scope, Exit.void);

        const restarted = yield* Layer.build(start);
        const askAgain = yield* attemptOn(restarted);
        const afterRestart = yield* askAgain("/test-plan/chat/completions");
        const again = yield* adminOf(restarted);
        yield* again.llm.disconnect({ params: { provider: plan.id } });
        const afterDisconnect = yield* askAgain("/test-plan/chat/completions");
        assert.deepStrictEqual(
          [connected, reloaded, afterRestart, afterDisconnect],
          [200, 200, 200, 503],
        );
        const disconnected = yield* again.llm.connections();
        assert.strictEqual(disconnected.providers.at(-1)?.credential, null);

        assert.deepStrictEqual(upstream.seen, [
          ["/v1/chat/completions", `Bearer ${PLAN_KEY}`],
          ["/v1/chat/completions", `Bearer ${PLAN_KEY}`],
          ["/v1/chat/completions", `Bearer ${PLAN_KEY}`],
        ]);
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
