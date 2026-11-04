import { jsonKey } from "@usine/core/json-key";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Logger, Option, Redacted, Scope, Exit } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { GatewayAdminApi } from "../src/admin/api.ts";
import { GatewayAddresses, gatewayLayer } from "../src/node/node.ts";
import { SettingsInForce } from "../src/settings.ts";
import { ProviderCredentials } from "../src/credentials/store.ts";
import {
  ADMIN_TOKEN_VALUE,
  NO_PROVIDERS,
  settingsLayer,
  authFileText,
  chatGptAccessToken,
} from "./fixtures.ts";

const listener = { host: "127.0.0.1", port: 0 };
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
          state.providers.map(({ credential }) => credential),
          ["subscription", "subscription"],
        );
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
        assert.isTrue(Option.isSome((yield* current.current).providers.openai));
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
        const beforeDisconnect = yield* SettingsInForce.pipe(
          Effect.provideContext(restarted),
          Effect.flatMap((settings) => settings.current),
        );
        yield* credentials.disconnect("anthropic");
        yield* credentials.disconnect("openai");
        assert.deepEqual(
          (yield* credentials.status).map(({ credential }) => credential),
          [null, null],
        );
        const next = yield* credentials.apply(beforeDisconnect.providers);
        assert.isTrue(Option.isNone(next.anthropic));
        assert.isTrue(Option.isNone(next.openai));
      }),
    ).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
);
