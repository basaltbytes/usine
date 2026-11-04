import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Logger, Option, Redacted, Ref, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { jsonKey } from "@usine/core/json-key";
import {
  ProviderCredentialError,
  type ProviderCredential,
  ProviderStatus,
} from "@usine/gateway/credentials";
import { ProviderLogins } from "../src/providers/control.ts";
import { ProviderLoginRunner, loginPrompt } from "../src/providers/runner.ts";
import { ProviderTargets } from "../src/providers/targets.ts";
import { providerRoutes } from "../src/providers/http.ts";

it.effect("returns only allowlisted authorization prompts from terminal output", () =>
  Effect.sync(() => {
    assert.deepEqual(
      Option.getOrNull(
        loginPrompt("chatgpt", "https://auth.openai.com/codex/device\nABCD-EFGH\nsecret=private"),
      ),
      { url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH" },
    );
    assert.isTrue(Option.isNone(loginPrompt("chatgpt", "https://evil.example\nABCD-EFGH")));
    assert.isTrue(Option.isNone(loginPrompt("chatgpt", "https://auth.openai.com/codex/device")));
    assert.isTrue(
      Option.isNone(loginPrompt("claude", "https://claude.com/cai/oauth/authorize?state=part")),
    );
    assert.deepEqual(
      Option.getOrNull(
        loginPrompt("claude", "https://claude.com/cai/oauth/authorize?state=complete\n"),
      ),
      { url: "https://claude.com/cai/oauth/authorize?state=complete", code: null },
    );
  }),
);

it.live(
  "keeps credentials out of operator responses and logs, and cancels or fails without replacing a login",
  () => {
    const lines: string[] = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const outcome = yield* Deferred.make<ProviderCredential, ProviderCredentialError>();
        const saved = yield* Ref.make<readonly ProviderCredential[]>([]);
        const layer = ProviderLogins.layer.pipe(
          Layer.provide([
            Layer.succeed(ProviderLoginRunner, {
              start: (provider) =>
                Effect.succeed({
                  prompt: Effect.succeed({
                    url: "https://auth.openai.com/codex/device",
                    code: "ABCD-EFGH",
                  }),
                  result:
                    provider === "claude"
                      ? Effect.fail(ProviderCredentialError.make({ message: "Login refused." }))
                      : Deferred.await(outcome),
                  submit: () => Effect.void,
                }),
            }),
            Layer.succeed(ProviderTargets, {
              list: Effect.succeed([{ target: "local", label: "Local harnesses", providers: [] }]),
              get: (target) => Effect.succeed({ target, label: "Local harnesses", providers: [] }),
              replace: (_target, credential) => Ref.update(saved, (all) => [...all, credential]),
              disconnect: () => Effect.void,
            }),
          ]),
          Layer.provide(NodeServices.layer),
        );
        const context = yield* Layer.build(layer);
        const logins = yield* ProviderLogins.pipe(Effect.provideContext(context));
        const failed = yield* logins.begin("local", "claude");
        yield* Effect.sleep("20 millis");
        assert.equal(
          (yield* logins.status).logins.find(({ id }) => id === failed.id)?.state.status,
          "failed",
        );
        const cancelled = yield* logins.begin("local", "chatgpt");
        yield* logins.cancel(cancelled.id);
        assert.equal(
          (yield* logins.status).logins.find(({ id }) => id === cancelled.id)?.state.status,
          "cancelled",
        );
        const afterCancel = yield* Ref.get(saved);
        assert.lengthOf(afterCancel, 0);
        const connected = yield* logins.begin("local", "chatgpt");
        yield* Deferred.succeed(outcome, {
          kind: "chatgpt-subscription" as const,
          secret: Redacted.make("private-access-and-refresh-tokens"),
        });
        yield* Effect.sleep("20 millis");
        assert.equal(
          (yield* logins.status).logins.find(({ id }) => id === connected.id)?.state.status,
          "connected",
        );
        const afterConnect = yield* Ref.get(saved);
        assert.lengthOf(afterConnect, 1);
        const app = HttpRouter.toWebHandler(
          providerRoutes.pipe(HttpRouter.provideRequest(Layer.succeed(ProviderLogins, logins))),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
        const response = yield* Effect.promise(() =>
          app.handler(new Request("http://localhost/api/providers")),
        );
        const body = yield* Effect.promise(() => response.text());
        assert.equal(response.status, 200);
        yield* Schema.decodeEffect(Schema.fromJsonString(ProviderStatus))(body);
        assert.notInclude(body + lines.join("\n"), "private-access-and-refresh-tokens");
        assert.notInclude(body, "ABCD-EFGH");
      }),
    ).pipe(
      Effect.provide([
        NodeServices.layer,
        Logger.layer([
          Logger.make(({ message }) => {
            lines.push(jsonKey(message));
          }),
        ]),
      ]),
    );
  },
);
