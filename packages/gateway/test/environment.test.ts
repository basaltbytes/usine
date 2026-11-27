import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { anthropic, modelProviders, openai } from "@usine/core/agent/provider";
import { ConfigProvider, Effect, FileSystem, Option } from "effect";
import { llmProviders } from "../src/node/environment.ts";
import { authFileText } from "./fixtures.ts";

/** Values of an upstream variable that send a credential over plain HTTP to another host. */
const REJECTED = [
  "http://evil.test",
  "http://127.0.0.1.evil.test",
  "http://localhost@evil.test",
  "http://localhost:99999",
  "http://127.0.0.999",
];

/** Values of an upstream variable that keep a credential on HTTPS or on the gateway's own host. */
const ACCEPTED = [
  "https://evil.test",
  "http://localhost:8080",
  "http://[::1]:8080",
  "http://127.0.0.1:8080",
  "http://127.255.255.255:8080/v1",
];

/**
 * Returns the upstream that `llmProviders` reads for `slot` from `env`, or the message of the
 * configuration error that it fails with.
 */
const upstreamOf = (slot: string, env: Readonly<Record<string, string>>) =>
  llmProviders(modelProviders).pipe(
    Effect.map((providers) =>
      Option.getOrElse(
        Option.flatMap(Option.fromNullishOr(providers[slot]), ({ upstream }) => upstream),
        () => "none",
      ),
    ),
    Effect.catchTag("ConfigError", ({ message }) => Effect.succeed(`refused: ${message}`)),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    Effect.provide([NodeServices.layer, NodeCrypto.layer]),
  );

describe("the gateway's upstream variables", () => {
  it.effect.each([
    ...REJECTED.map((value) => ({ value, accepted: false })),
    ...ACCEPTED.map((value) => ({ value, accepted: true })),
  ])("USINE_GATEWAY_ANTHROPIC_UPSTREAM=$value is accepted: $accepted", ({ value, accepted }) =>
    Effect.gen(function* () {
      const upstream = yield* upstreamOf(anthropic.slot, {
        ANTHROPIC_API_KEY: "sk-ant-api03-keyForEnvironmentTests",
        USINE_GATEWAY_ANTHROPIC_UPSTREAM: value,
      });

      if (accepted) assert.strictEqual(upstream, value);
      else {
        assert.include(upstream, "refused: ");
        assert.include(upstream, "USINE_GATEWAY_ANTHROPIC_UPSTREAM");
      }
    }),
  );

  it.effect.each([
    ...REJECTED.map((value) => ({ value, accepted: false })),
    ...ACCEPTED.map((value) => ({ value, accepted: true })),
  ])(
    "USINE_GATEWAY_CHATGPT_UPSTREAM=$value with a ChatGPT login is accepted: $accepted",
    ({ value, accepted }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "usine-gateway-environment-",
        });
        const authFile = `${directory}/auth.json`;
        yield* fileSystem.writeFileString(
          authFile,
          authFileText({ access: "chatgpt-access", refresh: "chatgpt-refresh" }),
        );
        const upstream = yield* upstreamOf(openai.slot, {
          USINE_GATEWAY_CHATGPT_AUTH_FILE: authFile,
          USINE_GATEWAY_CHATGPT_UPSTREAM: value,
        });

        if (accepted) assert.strictEqual(upstream, value);
        else {
          assert.include(upstream, "refused: ");
          assert.include(upstream, "USINE_GATEWAY_CHATGPT_UPSTREAM");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
