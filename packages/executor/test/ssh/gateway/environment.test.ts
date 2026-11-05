import { catalog } from "@usine/agents/harness";
import { jsonKey } from "@usine/core/json-key";
import { assert, describe, it } from "@effect/vitest";
import { GatewayDomain, type GatewayLlmProtocol } from "@usine/core/worker";
import { Redacted } from "effect";
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

const environmentFor = (llmProviders: ReadonlyArray<GatewayLlmProtocol>) => {
  const { exported, sent } = gatewayEnvironment({
    catalog,
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
    const { exported, sent } = environmentFor(["anthropic-messages"]);
    assert.deepStrictEqual(exported, {
      ...WITHOUT_LLM,
      ANTHROPIC_BASE_URL: "http://llm.gw.internal/anthropic-messages",
    });
    assert.deepStrictEqual(sent, { ...SENT_WITHOUT_LLM, ANTHROPIC_AUTH_TOKEN: CALLER_TOKEN });
  });

  it("points Codex at the Gateway through its CODEX_HOME only when the Gateway holds the OpenAI credential", () => {
    const { exported, sent } = environmentFor(["openai-responses"]);
    assert.deepStrictEqual(exported, {
      ...WITHOUT_LLM,
      CODEX_HOME: "/home/usine/.usine/workers/eu-one/codex",
    });
    assert.deepStrictEqual(sent, { ...SENT_WITHOUT_LLM, USINE_GATEWAY_TOKEN: CALLER_TOKEN });
    assert.deepStrictEqual(
      Object.keys(environmentFor(["anthropic-messages", "openai-responses"]).sent),
      [...gatewaySentVariables(catalog)],
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
