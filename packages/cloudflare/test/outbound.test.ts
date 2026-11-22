import { describe, expect, it } from "@effect/vitest";
import { DateTime, Option, Redacted, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { ApiKeyCredential, ProviderGrant, SandboxCredentials } from "../src/api/api.ts";
import { Harness } from "@usine/core/agent/brain";
import {
  anthropic,
  ApiKeyCredential as KeyCredential,
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
import { harnessEnvironment, sandboxHost } from "../src/api/harness.ts";
import {
  allowedHostsOf,
  forwardRequest,
  gitHubRequest,
  interceptionsFor,
  providerRequest,
} from "../src/sandbox/outbound.ts";

const issuedAt = DateTime.makeUnsafe("2026-10-26T08:00:00.000Z");

const credentials = SandboxCredentials.make({
  issuedAt,
  github: Option.some(Redacted.make("ghs_installation-token")),
  providers: [
    ProviderGrant.make({
      provider: anthropic.id,
      credential: ApiKeyCredential.make({ key: Redacted.make("sk-ant-key") }),
    }),
  ],
});

/**
 * A provider that only this test defines: one static key for two protocols, which take the key in
 * different headers at different upstreams, and one header that passes to the upstream.
 */
const plan = ModelProvider.make({
  id: ModelProviderId.make("test-plan"),
  slot: GatewaySlot.make("test-plan"),
  label: "Test plan",
  protocols: [
    ProviderProtocol.make({
      protocol: WireProtocol.make("openai-chat-completions"),
      upstream: UpstreamBase.make("https://plan.test/openai/v1"),
      routes: [RoutePattern.make("/chat/completions")],
      key: KeyHeader.make({ header: HeaderName.make("authorization"), scheme: "bearer" }),
    }),
    ProviderProtocol.make({
      protocol: WireProtocol.make("google-generate-content"),
      upstream: UpstreamBase.make("https://plan.test/google/v1beta"),
      routes: [RoutePattern.make("/models/{model}:streamGenerateContent")],
      key: KeyHeader.make({ header: HeaderName.make("x-goog-api-key"), scheme: "none" }),
    }),
  ],
  credentials: [KeyCredential.make({ variable: GatewayVariable.make("TEST_PLAN_API_KEY") })],
  passThrough: Option.some([HeaderName.make("x-plan-session")]),
});

describe("sandbox outbound handlers", () => {
  it.effect("forwards an allowlisted WebSocket upgrade and preserves its native response", () =>
    Effect.gen(function* () {
      const request = new Request("https://allowed.example/socket?session=private", {
        headers: { upgrade: "websocket", connection: "Upgrade" },
        redirect: "manual",
      });
      class UpgradeResponse extends Response {
        override get status() {
          return 101;
        }
      }
      const upstream = new UpgradeResponse(null, { headers: { upgrade: "websocket" } });
      const received: Array<Parameters<typeof fetch>[0]> = [];
      const response = yield* forwardRequest("allowed", request).pipe(
        Effect.provideService(FetchHttpClient.Fetch, (input) => {
          received.push(input);
          return Promise.resolve(upstream);
        }),
      );

      expect(received[0]).toBe(request);
      expect(response).toBe(upstream);
      expect(response.status).toBe(101);
      expect(response.headers.get("upgrade")).toBe("websocket");
    }),
  );

  it("never lets an allowlisted host bypass the GitHub and provider credentials", () => {
    const interceptions = interceptionsFor(
      modelProviders,
      credentials,
      allowedHostsOf(" registry.npmjs.org, GitHub.com,api.github.com,,anthropic.usine.internal"),
    );

    expect(interceptions.map(({ _tag, host }) => `${_tag}:${host}`)).toEqual([
      "GitHub:github.com",
      "GitHub:api.github.com",
      "Provider:anthropic.usine.internal",
      "Denied:openai.usine.internal",
      "Allowed:registry.npmjs.org",
    ]);
  });

  it("replaces the sandbox's credential with the installation token for each GitHub host", () => {
    const token = Redacted.make("ghs_installation-token");
    const git = gitHubRequest(
      new Request("https://github.com/acme/demo.git/info/refs?service=git-upload-pack", {
        headers: { authorization: "token usine-placeholder", "user-agent": "git/2.47" },
      }),
      "github.com",
      token,
    );
    const api = gitHubRequest(
      new Request("https://api.github.com/repos/acme/demo", {
        headers: { authorization: "token usine-placeholder" },
      }),
      "api.github.com",
      token,
    );

    expect(git.headers.get("authorization")).toBe(
      `Basic ${btoa("x-access-token:ghs_installation-token")}`,
    );
    expect(git.headers.get("user-agent")).toBe("git/2.47");
    expect(git.url).toBe("https://github.com/acme/demo.git/info/refs?service=git-upload-pack");
    expect(api.headers.get("authorization")).toBe("token ghs_installation-token");
    const smuggled = gitHubRequest(
      new Request("https://github.com//attacker.example/collect"),
      "github.com",
      token,
    );
    expect(new URL(smuggled.url).host).toBe("github.com");
  });

  it.live("forwards a provider request to its upstream over HTTPS with the API key", () =>
    Effect.gen(function* () {
      const toAnthropic = Option.getOrThrow(
        providerRequest(
          new Request(`http://${sandboxHost(anthropic.id)}/v1/messages?beta=true`, {
            method: "POST",
            headers: { "x-api-key": "usine-placeholder", "anthropic-version": "2023-06-01" },
            body: '{"model":"claude"}',
          }),
          anthropic,
          ApiKeyCredential.make({ key: Redacted.make("sk-ant-key") }),
        ),
      );
      const toOpenai = Option.getOrThrow(
        providerRequest(
          new Request(`http://${sandboxHost(openai.id)}/v1/responses`, {
            method: "POST",
            headers: { authorization: "Bearer usine-placeholder" },
          }),
          openai,
          ApiKeyCredential.make({ key: Redacted.make("sk-openai-key") }),
        ),
      );

      expect(toAnthropic.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
      expect(toAnthropic.method).toBe("POST");
      expect(toAnthropic.headers.get("x-api-key")).toBe("sk-ant-key");
      expect(toAnthropic.headers.get("anthropic-version")).toBe("2023-06-01");
      const actual1 = yield* Effect.promise(() => toAnthropic.text());
      expect(actual1).toBe('{"model":"claude"}');
      expect(toOpenai.url).toBe("https://api.openai.com/v1/responses");
      expect(toOpenai.headers.get("authorization")).toBe("Bearer sk-openai-key");
    }),
  );

  it("adds the API key only to the provider's routes in the catalog", () => {
    const key = ApiKeyCredential.make({ key: Redacted.make("sk-key") });
    const forward = (provider: ModelProvider, method: string, path: string) =>
      Option.map(
        providerRequest(
          new Request(`http://${sandboxHost(provider.id)}${path}`, { method }),
          provider,
          key,
        ),
        (forwarded) => `${forwarded.method} ${forwarded.url}`,
      );

    expect(forward(anthropic, "GET", "/v1/models/claude-opus-4-5?beta=true")).toEqual(
      Option.some("GET https://api.anthropic.com/v1/models/claude-opus-4-5?beta=true"),
    );
    expect(forward(anthropic, "POST", "/v1/messages/count_tokens")).toEqual(
      Option.some("POST https://api.anthropic.com/v1/messages/count_tokens"),
    );
    expect(forward(openai, "POST", "/v1/responses/compact")).toEqual(
      Option.some("POST https://api.openai.com/v1/responses/compact"),
    );
    const refused = [
      forward(openai, "GET", "/v1/files"),
      forward(openai, "DELETE", "/v1/files/file-abc123"),
      forward(openai, "POST", "/v1/responses/../files"),
      forward(openai, "POST", "/v1/responses%2F..%2Ffiles"),
      forward(anthropic, "GET", "/v1/files"),
      forward(anthropic, "POST", "/v1/messages/batches"),
      forward(anthropic, "GET", "/v1/organizations/api_keys"),
      forward(anthropic, "POST", "//attacker.example/v1/messages"),
      forward(anthropic, "POST", "/\\attacker.example/v1/messages"),
      forward(plan, "POST", "/v1/files"),
      forward(plan, "POST", "/models/..:streamGenerateContent"),
    ];
    expect(refused.filter(Option.isSome)).toEqual([]);
  });

  it.live(
    "sends a catalog provider's request to the upstream of the protocol that serves it, with the key in its header",
    () =>
      Effect.gen(function* () {
        const granted = SandboxCredentials.make({
          issuedAt,
          github: Option.none(),
          providers: [
            ProviderGrant.make({
              provider: plan.id,
              credential: ApiKeyCredential.make({ key: Redacted.make("plan-key") }),
            }),
          ],
        });
        const catalog = ModelProviderCatalog.make({
          providers: [...modelProviders.providers, plan],
        });
        expect(
          interceptionsFor(catalog, granted, []).map(({ _tag, host }) => `${_tag}:${host}`),
        ).toEqual([
          "Denied:github.com",
          "Denied:api.github.com",
          "Denied:anthropic.usine.internal",
          "Denied:openai.usine.internal",
          "Provider:test-plan.usine.internal",
        ]);
        const key = ApiKeyCredential.make({ key: Redacted.make("plan-key") });
        const chat = Option.getOrThrow(
          providerRequest(
            new Request(`http://${sandboxHost(plan.id)}/chat/completions`, {
              method: "POST",
              headers: {
                authorization: "Bearer usine-placeholder",
                "x-goog-api-key": "usine-placeholder",
                "x-plan-session": "session-1",
                "x-unlisted": "dropped",
                "content-type": "application/json",
              },
              body: '{"model":"plan-model"}',
            }),
            plan,
            key,
          ),
        );
        const generate = Option.getOrThrow(
          providerRequest(
            new Request(
              `http://${sandboxHost(plan.id)}/models/plan-model-2.5:streamGenerateContent?alt=sse`,
              { method: "POST", headers: { "x-goog-api-key": "usine-placeholder" } },
            ),
            plan,
            key,
          ),
        );

        expect(chat.url).toBe("https://plan.test/openai/v1/chat/completions");
        expect([...chat.headers.entries()]).toEqual([
          ["authorization", "Bearer plan-key"],
          ["content-type", "application/json"],
          ["x-plan-session", "session-1"],
        ]);
        const body = yield* Effect.promise(() => chat.text());
        expect(body).toBe('{"model":"plan-model"}');
        expect(generate.url).toBe(
          "https://plan.test/google/v1beta/models/plan-model-2.5:streamGenerateContent?alt=sse",
        );
        expect([...generate.headers.entries()]).toEqual([["x-goog-api-key", "plan-key"]]);
      }),
  );

  it("points only the configured providers' harnesses at their handlers", () => {
    const claudeOnly = harnessEnvironment(
      [anthropic.id, openai.id],
      Option.some(Harness.make("claude")),
    );

    expect(claudeOnly["ANTHROPIC_BASE_URL"]).toBe("http://anthropic.usine.internal");
    expect(claudeOnly["OPENAI_API_KEY"]).toBeUndefined();
    expect(claudeOnly["SSL_CERT_FILE"]).toBe("/etc/cloudflare/certs/cloudflare-containers-ca.crt");
    expect(
      harnessEnvironment([anthropic.id, openai.id], Option.some(Harness.make("codex")))[
        "ANTHROPIC_BASE_URL"
      ],
    ).toBeUndefined();
  });
});
