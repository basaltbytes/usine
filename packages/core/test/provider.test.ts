import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import {
  anthropic,
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  modelProviders,
  openai,
  ProviderProtocol,
  RoutePattern,
  routeServes,
} from "../src/agent/provider/catalog.ts";

describe("model providers", () => {
  it("matches a placeholder to one plain segment, and no dot, empty, or encoded segment", () => {
    const model = RoutePattern.make("/v1/models/{model}");
    const stream = RoutePattern.make("/v1beta/models/{model}:streamGenerateContent");
    assert.isTrue(routeServes(model, "/v1/models/claude-haiku-5.5"));
    assert.isTrue(routeServes(stream, "/v1beta/models/gemini-3:streamGenerateContent"));
    for (const path of [
      "/v1/models/..",
      "/v1/models/.hidden",
      "/v1/models/",
      "/v1/models/a%2Fb",
      "/v1/models/a/b",
      "/v1/modelsX/a",
    ])
      assert.isFalse(routeServes(model, path), path);
    assert.isFalse(routeServes(stream, "/v1beta/models/gemini-3:generateContent"));
    assert(Option.isNone(RoutePattern.makeOption("/v1//messages")));
    assert(Option.isNone(RoutePattern.makeOption("/v1/messages/")));
  });

  it("finds a provider by slot or by ID, and decodes either name to the slot", () => {
    assert.deepStrictEqual(modelProviders.find("anthropic-messages"), Option.some(anthropic));
    assert.deepStrictEqual(modelProviders.find("openai"), Option.some(openai));
    assert(Option.isNone(modelProviders.find("google")));
    const decode = Schema.decodeUnknownOption(modelProviders.slotFromName);
    assert.deepStrictEqual(decode("openai"), Option.some("openai-responses"));
    assert.deepStrictEqual(decode("anthropic-messages"), Option.some("anthropic-messages"));
    assert(Option.isNone(decode("google")));
    assert.deepStrictEqual(
      Schema.encodeOption(modelProviders.slotFromName)(GatewaySlot.make("openai-responses")),
      Option.some("openai-responses"),
    );
  });

  it("splits a path into the provider that its first segment names and the rest", () => {
    assert.deepStrictEqual(
      modelProviders.target("/anthropic-messages/v1/messages"),
      Option.some({ provider: anthropic, rest: "/v1/messages", legacy: false }),
    );
    assert.deepStrictEqual(
      modelProviders.target("/openai/v1/responses"),
      Option.some({ provider: openai, rest: "/v1/responses", legacy: true }),
    );
    assert.deepStrictEqual(
      modelProviders.target("/openai-responses"),
      Option.some({ provider: openai, rest: "", legacy: false }),
    );
    for (const path of ["/google/v1/models", "/", "anthropic/v1/messages", "/Anthropic/v1"])
      assert(Option.isNone(modelProviders.target(path)), path);
  });

  it("splits a path under a slot that is also its provider's ID without the legacy flag", () => {
    const plan = ModelProvider.make({
      ...openai,
      id: ModelProviderId.make("test-plan"),
      slot: GatewaySlot.make("test-plan"),
    });
    const catalog = ModelProviderCatalog.make({ providers: [anthropic, plan] });
    assert.deepStrictEqual(
      catalog.target("/test-plan/v1/responses"),
      Option.some({ provider: plan, rest: "/v1/responses", legacy: false }),
    );
    assert.deepStrictEqual(
      catalog.target("/anthropic/v1/messages"),
      Option.some({ provider: anthropic, rest: "/v1/messages", legacy: true }),
    );
  });

  it("refuses a provider name that names two providers", () => {
    const renamed = (id: string, slot: string) =>
      ModelProvider.make({
        ...openai,
        id: ModelProviderId.make(id),
        slot: GatewaySlot.make(slot),
      });
    assert(
      Option.isNone(
        ModelProviderCatalog.makeOption({
          providers: [anthropic, renamed("anthropic-messages", "other")],
        }),
      ),
    );
    assert(
      Option.isSome(
        ModelProviderCatalog.makeOption({ providers: [anthropic, renamed("other", "other")] }),
      ),
    );
  });

  it("refuses a route in two protocols and two credentials of one kind", () => {
    const [protocol] = anthropic.protocols;
    assert(
      Option.isNone(
        ModelProvider.makeOption({
          ...anthropic,
          protocols: [
            protocol,
            ProviderProtocol.make({ ...protocol, protocol: openai.protocols[0].protocol }),
          ],
        }),
      ),
    );
    assert(
      Option.isNone(
        ModelProvider.makeOption({
          ...anthropic,
          credentials: [
            ApiKeyCredential.make({ variable: GatewayVariable.make("FIRST_KEY") }),
            ApiKeyCredential.make({ variable: GatewayVariable.make("SECOND_KEY") }),
          ],
        }),
      ),
    );
    assert.deepStrictEqual(anthropic.kinds, ["api-key", "subscription"]);
    assert.deepStrictEqual(anthropic.hosts, ["api.anthropic.com"]);
  });
});
