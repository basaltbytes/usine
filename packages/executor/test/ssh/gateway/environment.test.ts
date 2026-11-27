import { catalog } from "@usine/agents/harness";
import { jsonKey } from "@usine/core/json-key";
import { assert, describe, it } from "@effect/vitest";
import { Harness } from "@usine/core/agent/brain";
import { GatewaySlot } from "@usine/core/agent/provider";
import { GatewayDomain } from "@usine/core/worker";
import { Option, Redacted } from "effect";
import {
  gatewayConfigFiles,
  gatewayEnvironment,
  type GatewayLlmPrefixes,
} from "../../../src/ssh/gateway/environment.ts";

const CALLER_TOKEN = "ugw1.sample-claims.sample-signature";
const DIRECTORIES = {
  ghConfigDirectory: "/home/usine/.usine/workers/eu-one/gh",
  homes: { codex: "/home/usine/.usine/workers/eu-one/codex" },
};

/** Returns the slots that `names` name. */
const slots = (...names: ReadonlyArray<string>) => names.map((name) => GatewaySlot.make(name));

const environmentFor = (
  llmProviders: ReadonlyArray<string>,
  harness: Option.Option<Harness> = Option.none(),
  llmPrefixes: GatewayLlmPrefixes = "slot",
) => {
  const { exported, sent } = gatewayEnvironment({
    catalog,
    harness,
    domain: GatewayDomain.make("gw.internal"),
    llmProviders: slots(...llmProviders),
    llmPrefixes,
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

  it("isolates each harness's wiring when every descriptor is registered", () => {
    const options = {
      catalog,
      domain: GatewayDomain.make("gw.internal"),
      llmProviders: slots("anthropic-messages", "openai-responses", "opencode-go"),
      llmPrefixes: "slot" as const,
      ...DIRECTORIES,
      homes: { ...DIRECTORIES.homes, opencode: "/attempt/opencode" },
      callerToken: Redacted.make(CALLER_TOKEN),
    };
    for (const harness of catalog.ids) {
      const { exported, sent } = gatewayEnvironment({ ...options, harness: Option.some(harness) });
      const environment = { ...exported, ...sent };
      assert.strictEqual("ANTHROPIC_BASE_URL" in environment, harness === "claude");
      assert.strictEqual("ANTHROPIC_AUTH_TOKEN" in environment, harness === "claude");
      assert.strictEqual("CODEX_HOME" in environment, harness === "codex");
      assert.strictEqual(
        "USINE_GATEWAY_TOKEN" in environment,
        harness === "codex" || harness === "opencode",
      );
      assert.strictEqual("USINE_OPENCODE_HOME" in environment, harness === "opencode");
      assert.strictEqual("USINE_OPENCODE_OPENAI_BASE_URL" in environment, harness === "opencode");
      // The attempt's own API key sets `USINE_OPENCODE_BASE_URL`; the gateway never does.
      assert.notProperty(environment, "USINE_OPENCODE_BASE_URL");
      assert.strictEqual("USINE_OPENCODE_GO_BASE_URL" in environment, harness === "opencode");
      assert.strictEqual(exported.GH_HOST, "git.gw.internal");
    }
    const opencode = gatewayEnvironment({
      ...options,
      harness: Option.some(Harness.make("opencode")),
    });
    assert.strictEqual(opencode.exported.USINE_OPENCODE_HOME, "/attempt/opencode");
    assert.strictEqual(
      opencode.exported.USINE_OPENCODE_OPENAI_BASE_URL,
      "http://llm.gw.internal/openai-responses/v1",
    );
    assert.strictEqual(
      opencode.exported.USINE_OPENCODE_GO_BASE_URL,
      "http://llm.gw.internal/opencode-go",
    );
    assert.deepStrictEqual(
      gatewayEnvironment({ ...options, harness: Option.none() }).exported,
      WITHOUT_LLM,
    );
  });

  it("writes Codex's model provider, without a token, only when the Gateway holds the OpenAI credential", () => {
    const files = (llmProviders: ReadonlyArray<string>) =>
      Object.fromEntries(
        gatewayConfigFiles({
          catalog,
          domain: GatewayDomain.make("gw.internal"),
          llmProviders: slots(...llmProviders),
          llmPrefixes: "slot",
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

  it("points Claude Code and Codex at the provider prefixes of a Gateway from before protocol slots", () => {
    const claude = environmentFor(
      ["anthropic-messages", "openai-responses"],
      Option.some(Harness.make("claude")),
      "provider",
    );
    assert.strictEqual(claude.exported.ANTHROPIC_BASE_URL, "http://llm.gw.internal/anthropic");
    const files = Object.fromEntries(
      gatewayConfigFiles({
        catalog,
        domain: GatewayDomain.make("gw.internal"),
        llmProviders: slots("openai-responses"),
        llmPrefixes: "provider",
        ...DIRECTORIES,
      }),
    );
    assert.strictEqual(
      files["/home/usine/.usine/workers/eu-one/codex/config.toml"],
      CODEX_CONFIG.replace("/openai-responses/v1", "/openai/v1"),
    );
    const current = environmentFor(["anthropic-messages"], Option.some(Harness.make("claude")));
    assert.strictEqual(
      current.exported.ANTHROPIC_BASE_URL,
      "http://llm.gw.internal/anthropic-messages",
    );
  });
});
