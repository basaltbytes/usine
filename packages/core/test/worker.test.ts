import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  GATEWAY_LEGACY_PROVIDERS,
  GatewayLlmProtocol,
  GatewayLlmProtocolFromName,
  GatewayLlmProvider,
  gatewayLlmProtocolOf,
} from "../src/worker.ts";

describe("Gateway slot names", () => {
  it("reads each provider name from before protocol slots as the protocol that it names", () => {
    for (const provider of GatewayLlmProvider.literals) {
      const protocol = gatewayLlmProtocolOf(provider);
      assert.strictEqual(GATEWAY_LEGACY_PROVIDERS[protocol], provider);
    }
    for (const protocol of GatewayLlmProtocol.literals)
      assert.strictEqual(gatewayLlmProtocolOf(protocol), protocol);
  });

  it.effect("decodes either name to the protocol and encodes the protocol", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(GatewayLlmProtocolFromName);
      const provider = yield* decode("openai");
      const protocol = yield* decode("anthropic-messages");
      const encoded = yield* Schema.encodeEffect(GatewayLlmProtocolFromName)("openai-responses");
      assert.strictEqual(provider, "openai-responses");
      assert.strictEqual(protocol, "anthropic-messages");
      assert.strictEqual(encoded, "openai-responses");
      assert.deepStrictEqual(
        Schema.decodeUnknownOption(GatewayLlmProtocolFromName)("google"),
        Option.none(),
      );
    }),
  );
});
