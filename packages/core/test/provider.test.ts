import { assert, describe, it } from "@effect/vitest";
import { Option, Schema } from "effect";
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
} from "../src/agent/provider/catalog.ts";

/** Returns the protocol of the test plan that serves `route` and `others`. */
const serving = (protocol: string, route: string, ...others: ReadonlyArray<string>) =>
  ProviderProtocol.make({
    protocol: WireProtocol.make(protocol),
    upstream: UpstreamBase.make("https://plan.test"),
    routes: [RoutePattern.make(route), ...others.map((other) => RoutePattern.make(other))],
    key: KeyHeader.make({ header: HeaderName.make("x-api-key"), scheme: "none" }),
  });

/** A provider that only these tests define, which serves `protocols` with one key. */
const plan = (...protocols: ReadonlyArray<ProviderProtocol>) =>
  ModelProvider.makeOption({
    id: ModelProviderId.make("test-plan"),
    slot: GatewaySlot.make("test-plan"),
    label: "Test plan",
    protocols: [protocols[0] ?? serving("plan-messages", "/v1/messages"), ...protocols.slice(1)],
    credentials: [ApiKeyCredential.make({ variable: GatewayVariable.make("TEST_PLAN_API_KEY") })],
  });

describe("model providers", () => {
  it("matches a placeholder to one plain segment, and no dot, empty, or encoded segment", () => {
    const model = serving("plan-models", "/v1/models/{model}");
    const stream = serving("plan-stream", "/v1beta/models/{model}:streamGenerateContent");
    assert.isTrue(model.serves("/v1/models/claude-haiku-5.5"));
    assert.isTrue(stream.serves("/v1beta/models/gemini-3:streamGenerateContent"));
    for (const path of [
      "/v1/models/..",
      "/v1/models/.hidden",
      "/v1/models/",
      "/v1/models/a%2Fb",
      "/v1/models/a/b",
      "/v1/modelsX/a",
      "v1/models/a",
    ])
      assert.isFalse(model.serves(path), path);
    assert.isFalse(stream.serves("/v1beta/models/gemini-3:generateContent"));
    assert(Option.isNone(RoutePattern.makeOption("/v1//messages")));
    assert(Option.isNone(RoutePattern.makeOption("/v1/messages/")));
  });

  it("refuses a route with a . or .. segment", () => {
    for (const route of ["/v1/./messages", "/v1/../messages", "/v1/..", "/."])
      assert(Option.isNone(RoutePattern.makeOption(route)), route);
    assert(Option.isSome(RoutePattern.makeOption("/v1/.well-known/a..b")));
  });

  it("refuses two placeholders in one segment without a literal between them", () => {
    assert(Option.isNone(RoutePattern.makeOption("/v1/{a}{b}x")));
    assert(Option.isNone(RoutePattern.makeOption("/v1/{a}{b}{c}x")));
    assert(Option.isSome(RoutePattern.makeOption("/v1/{a}-{b}")));
    assert(Option.isSome(RoutePattern.makeOption("/v1/{a}/{b}")));
  });

  it("matches a long path in time linear in its length, even with placeholders a literal can end", () => {
    const pairs = serving("plan-pairs", "/v1/{a}-{b}-{c}x", "/v1/{a}.{b}");
    const long = `/v1/${"a-".repeat(8_000)}`;
    const started = performance.now();
    assert.isFalse(pairs.serves(long));
    assert.isTrue(pairs.serves(`${long}ax`));
    assert.isTrue(pairs.serves("/v1/a.b.c"));
    assert.isFalse(pairs.serves("/v1/a."));
    assert.isBelow(performance.now() - started, 200);
  });

  it("refuses a key in a hop-by-hop header or a header that frames the body", () => {
    for (const header of [
      "host",
      "content-type",
      "content-length",
      "content-encoding",
      "connection",
      "transfer-encoding",
      "te",
      "upgrade",
    ])
      assert(
        Option.isNone(KeyHeader.makeOption({ header: HeaderName.make(header), scheme: "none" })),
        header,
      );
    assert(
      Option.isSome(
        KeyHeader.makeOption({ header: HeaderName.make("x-goog-api-key"), scheme: "none" }),
      ),
    );
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

  it("refuses two protocols of one provider whose routes can match one path", () => {
    for (const [left, right] of [
      ["/v1/messages", "/v1/messages"],
      ["/v1/models/{model}", "/v1/models/gpt-5"],
      ["/v1/{kind}/list", "/v1/models/{model}"],
      ["/v1/{name}.json", "/v1/x{suffix}"],
      ["/v1/{model}:count", "/v1/{a}-{b}:count"],
    ] as const)
      assert(
        Option.isNone(plan(serving("plan-left", left), serving("plan-right", right))),
        `${left} ${right}`,
      );
    for (const [left, right] of [
      ["/v1/models/{model}", "/v1/models/{model}:streamGenerateContent"],
      ["/v1/{name}", "/v1/.well-known"],
      ["/v1/{name}", "/v1/a/b"],
      ["/v1/{model}:count", "/v1/{model}:generate"],
    ] as const)
      assert(
        Option.isSome(plan(serving("plan-left", left), serving("plan-right", right))),
        `${left} ${right}`,
      );
    assert(
      Option.isSome(
        plan(
          serving("plan-left", "/v1/models/{model}", "/v1/models/gpt-5"),
          serving("plan-right", "/v2"),
        ),
      ),
    );
  });

  it("refuses two credentials of one kind", () => {
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

  it("refuses two providers that read one credential or upstream variable", () => {
    const own = Option.getOrThrow(plan());
    const reading = (changes: Partial<ModelProvider>) =>
      ModelProviderCatalog.makeOption({
        providers: [anthropic, ModelProvider.make({ ...own, ...changes })],
      });
    assert(
      Option.isNone(
        reading({
          credentials: [
            ApiKeyCredential.make({ variable: GatewayVariable.make("ANTHROPIC_API_KEY") }),
          ],
        }),
      ),
    );
    assert(
      Option.isNone(
        reading({
          upstreamVariable: Option.some(GatewayVariable.make("USINE_GATEWAY_ANTHROPIC_UPSTREAM")),
        }),
      ),
    );
    assert(Option.isSome(reading({})));
    assert(
      Option.isSome(
        reading({ upstreamVariable: Option.some(GatewayVariable.make("TEST_PLAN_UPSTREAM")) }),
      ),
    );
  });
});
