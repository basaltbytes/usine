import {
  catalog,
  HarnessCatalog,
  HarnessCredential,
  HarnessDescriptor,
  CredentialWiring,
} from "@usine/agents/harness";
import { jsonKey } from "@usine/core/json-key";
import { assert, describe, it } from "@effect/vitest";
import { Harness } from "@usine/core/agent/brain";
import { GatewayDomain, type GatewayLlmProtocol } from "@usine/core/worker";
import { Option, Redacted } from "effect";
import {
  gatewaySentVariables,
  gatewayConfigFiles,
  gatewayEnvironment,
} from "../../../src/ssh/gateway/environment.ts";

const CALLER_TOKEN = "ugw1.sample-claims.sample-signature";
const DIRECTORIES = {
  ghConfigDirectory: "/home/usine/.usine/workers/eu-one/gh",
  homes: { codex: "/home/usine/.usine/workers/eu-one/codex" },
};

const environmentFor = (
  llmProviders: ReadonlyArray<GatewayLlmProtocol>,
  harness: Option.Option<Harness> = Option.none(),
) => {
  const { exported, sent } = gatewayEnvironment({
    catalog,
    harness,
    domain: GatewayDomain.make("gw.internal"),
    llmProviders,
    ...DIRECTORIES,
    callerToken: Redacted.make(CALLER_TOKEN),
  });
  return {
    exported,
    sent: Object.fromEntries(
      Object.entries(sent).map(([name, value]) => [name, Redacted.value(value)]),
    ),
  };
};

const WITHOUT_LLM = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "http.http://git.gw.internal/.extraHeader",
  GIT_CONFIG_KEY_1: "url.http://git.gw.internal/.insteadOf",
  GIT_CONFIG_VALUE_1: "https://github.com/",
  GIT_CONFIG_KEY_2: "url.http://git.gw.internal/.insteadOf",
  GIT_CONFIG_VALUE_2: "https://git.gw.internal/",
  GH_HOST: "git.gw.internal",
  GH_CONFIG_DIR: "/home/usine/.usine/workers/eu-one/gh",
  GH_PROMPT_DISABLED: "1",
  HTTPS_PROXY: "http://gw.internal:3128",
  HTTP_PROXY: "http://gw.internal:3128",
  https_proxy: "http://gw.internal:3128",
  http_proxy: "http://gw.internal:3128",
  NO_PROXY: "localhost,127.0.0.1,::1,gw.internal",
  no_proxy: "localhost,127.0.0.1,::1,gw.internal",
};

const SENT_WITHOUT_LLM = {
  GIT_CONFIG_VALUE_0: `x-usine-gateway-token: ${CALLER_TOKEN}`,
  GH_ENTERPRISE_TOKEN: CALLER_TOKEN,
  GH_TOKEN: CALLER_TOKEN,
};

const CODEX_CONFIG = `model_provider = "usine-gateway"

[model_providers.usine-gateway]
name = "usine gateway"
base_url = "http://llm.gw.internal/openai-responses/v1"
env_key = "USINE_GATEWAY_TOKEN"
wire_api = "responses"
requires_openai_auth = false
`;

describe("An Attempt's environment behind a Gateway", () => {
  it("points git, gh, and package managers at the Gateway, with the caller token only in what is sent", () => {
    const { exported, sent } = environmentFor([]);
    assert.deepStrictEqual(exported, WITHOUT_LLM);
    assert.deepStrictEqual(sent, SENT_WITHOUT_LLM);
    assert.notInclude(jsonKey(exported), CALLER_TOKEN);
  });

  it("points Claude Code at the Gateway only when the Gateway holds the Anthropic credential", () => {
    const { exported, sent } = environmentFor(
      ["anthropic-messages"],
      Option.some(Harness.make("claude")),
    );
    assert.deepStrictEqual(exported, {
      ...WITHOUT_LLM,
      ANTHROPIC_BASE_URL: "http://llm.gw.internal/anthropic-messages",
    });
    assert.deepStrictEqual(sent, { ...SENT_WITHOUT_LLM, ANTHROPIC_AUTH_TOKEN: CALLER_TOKEN });
  });

  it("points Codex at the Gateway through its CODEX_HOME only when the Gateway holds the OpenAI credential", () => {
    const { exported, sent } = environmentFor(
      ["openai-responses"],
      Option.some(Harness.make("codex")),
    );
    assert.deepStrictEqual(exported, {
      ...WITHOUT_LLM,
      CODEX_HOME: "/home/usine/.usine/workers/eu-one/codex",
    });
    assert.deepStrictEqual(sent, { ...SENT_WITHOUT_LLM, USINE_GATEWAY_TOKEN: CALLER_TOKEN });
    assert.includeMembers(gatewaySentVariables(catalog), Object.keys(sent));
  });

  it("isolates each harness's wiring when every descriptor is registered", () => {
    const claude = catalog.descriptors.find(({ id }) => id === "claude");
    assert(claude !== undefined && Option.isSome(claude.worker.credential));
    const opencode = HarnessDescriptor.make({
      ...claude,
      id: Harness.make("opencode"),
      worker: {
        ...claude.worker,
        credential: Option.some(
          HarnessCredential.make({
            ...claude.worker.credential.value,
            home: Option.some("XDG_DATA_HOME"),
            gateway: CredentialWiring.make({
              tokenVariable: "OPENCODE_TOKEN",
              environment: { XDG_DATA_HOME: "{{home}}", OPENCODE_CONFIG_CONTENT: "{{baseUrl}}" },
              files: {},
            }),
          }),
        ),
      },
    });
    const source = HarnessCatalog.make({ descriptors: [...catalog.descriptors, opencode] });
    const options = {
      catalog: source,
      domain: GatewayDomain.make("gw.internal"),
      llmProviders: ["anthropic-messages", "openai-responses"] as const,
      ...DIRECTORIES,
      homes: { ...DIRECTORIES.homes, opencode: "/attempt/opencode" },
      callerToken: Redacted.make(CALLER_TOKEN),
    };
    for (const harness of source.ids) {
      const { exported, sent } = gatewayEnvironment({ ...options, harness: Option.some(harness) });
      const environment = { ...exported, ...sent };
      assert.strictEqual("ANTHROPIC_BASE_URL" in environment, harness === "claude");
      assert.strictEqual("ANTHROPIC_AUTH_TOKEN" in environment, harness === "claude");
      assert.strictEqual("CODEX_HOME" in environment, harness === "codex");
      assert.strictEqual("USINE_GATEWAY_TOKEN" in environment, harness === "codex");
      assert.strictEqual("XDG_DATA_HOME" in environment, harness === "opencode");
      assert.strictEqual("OPENCODE_CONFIG_CONTENT" in environment, harness === "opencode");
      assert.strictEqual("OPENCODE_TOKEN" in environment, harness === "opencode");
      assert.strictEqual(exported.GH_HOST, "git.gw.internal");
    }
    assert.deepStrictEqual(
      gatewayEnvironment({ ...options, harness: Option.none() }).exported,
      WITHOUT_LLM,
    );
  });

  it("writes Codex's model provider, without a token, only when the Gateway holds the OpenAI credential", () => {
    const files = (llmProviders: ReadonlyArray<GatewayLlmProtocol>) =>
      Object.fromEntries(
        gatewayConfigFiles({
          catalog,
          domain: GatewayDomain.make("gw.internal"),
          llmProviders,
          ...DIRECTORIES,
        }),
      );
    assert.deepStrictEqual(Object.keys(files(["anthropic-messages"])), [
      "/home/usine/.usine/workers/eu-one/gh/config.yml",
      "/home/usine/.usine/workers/eu-one/gh/hosts.yml",
    ]);
    const withCodex = files(["openai-responses"]);
    assert.strictEqual(
      withCodex["/home/usine/.usine/workers/eu-one/codex/config.toml"],
      CODEX_CONFIG,
    );
    assert.notInclude(jsonKey(withCodex), CALLER_TOKEN);
  });
});
