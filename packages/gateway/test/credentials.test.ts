import { anthropic, GatewaySlot, modelProviders, openai } from "@usine/core/agent/provider";
import { jsonKey } from "@usine/core/json-key";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Record,
  Redacted,
  Schema,
  Scope,
  Exit,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { GatewayAdminApi } from "../src/admin/api.ts";
import { GatewayAddresses, gatewayLayer } from "../src/node/node.ts";
import { SettingsInForce } from "../src/settings.ts";
import { credentialProvider, loginLlmProvider } from "../src/credentials/model.ts";
import { CHATGPT_UPSTREAM, type LlmProviders } from "../src/llm/llm.ts";
import { ProviderCredentials } from "../src/credentials/store.ts";
import {
  ADMIN_TOKEN_VALUE,
  NO_PROVIDERS,
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
        const address = context.pipe((context) => Effect.provideContext(GatewayAddresses, context));
        const { admin } = yield* address;
        const client = yield* HttpApiClient.make(GatewayAdminApi, {
          baseUrl: `http://127.0.0.1:${admin.port}`,
          transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(ADMIN_TOKEN_VALUE)),
        });
        const claudeSecret = "sk-ant-oat01-private-fixture";
        yield* client.llm.connect({
          payload: { kind: "claude-subscription", secret: Redacted.make(claudeSecret) },
        });
        const now = yield* DateTime.now;
        const expiry = DateTime.add(now, { hours: 1 });
        const auth = authFileText({
          access: chatGptAccessToken(expiry),
          refresh: "refresh-private-fixture",
        });
        yield* client.llm.connect({
          payload: { kind: "chatgpt-subscription", secret: Redacted.make(auth) },
        });
        const malformed = yield* client.llm
          .connect({
            payload: {
              kind: "chatgpt-subscription",
              secret: Redacted.make("private-malformed-auth"),
            },
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
        yield* credentials.disconnect(GatewaySlot.make("anthropic-messages"));
        yield* credentials.disconnect(GatewaySlot.make("openai-responses"));
        assert.deepEqual(
          (yield* credentials.status).map(({ credential }) => credential),
          [null, null],
        );
        const next = yield* credentials.apply(beforeDisconnect.providers);
        assert.deepStrictEqual(next, {});
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);

it("connects each credential kind and login to the provider that accepts it", () => {
  const secret = Redacted.make("private-fixture");
  for (const kind of ["anthropic-api-key", "openai-api-key"] as const) {
    const provider = modelProviders.find(credentialProvider({ kind, secret }));
    assert(
      Option.exists(
        provider,
        (found) => found.accepts("api-key") && kind === `${found.id}-api-key`,
      ),
      kind,
    );
  }
  for (const login of ["claude", "chatgpt"] as const) {
    const slot = loginLlmProvider(login);
    assert.strictEqual(credentialProvider({ kind: `${login}-subscription`, secret }), slot);
    assert(
      Option.exists(modelProviders.find(slot), ({ credentials }) =>
        credentials.some(
          (credential) => credential._tag === "Subscription" && credential.login === login,
        ),
      ),
      login,
    );
  }
});

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
        const start = () =>
          gatewayLayer(
            { proxy: listener, egress: listener, admin: listener },
            undefined,
            directory,
          ).pipe(Layer.provide(settingsLayer(NO_PROVIDERS)), Layer.provide(logs));
        const secret = "sk-ant-api03-misplaced-private-fixture";
        const first = yield* Scope.make();
        const connected = yield* Layer.buildWithScope(start(), first);
        const credentials = yield* Effect.serviceOption(ProviderCredentials).pipe(
          Effect.provideContext(connected),
        );
        if (Option.isNone(credentials))
          return yield* Effect.die("Provider credential service missing");
        yield* credentials.value.replace({
          kind: "anthropic-api-key",
          secret: Redacted.make(secret),
        });
        yield* Scope.close(first, Exit.void);

        const StoredFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
        const stored = yield* fs
          .readFileString(file)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(StoredFile)));
        const record = stored[anthropic.slot];
        assert(record !== undefined);
        const misplaced = { [anthropic.slot]: record, [openai.slot]: record, "test-plan": record };
        const text = yield* Schema.encodeEffect(StoredFile)(misplaced);
        yield* fs.writeFileString(file, text);
        const restarted = yield* Layer.build(start());
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
        assert.notInclude(warnings.join("\n"), secret);
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);
