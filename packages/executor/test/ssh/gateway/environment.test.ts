import { assert, describe, it } from "@effect/vitest";
import { GatewayDomain } from "@usine/core/worker";
import { Redacted } from "effect";
import {
  GATEWAY_SENT_VARIABLES,
  gatewayEnvironment,
} from "../../../src/ssh/gateway/environment.ts";

const CALLER_TOKEN = "ugw1.sample-claims.sample-signature";

const environmentFor = (llmProviders: ReadonlyArray<"anthropic">) => {
  const { exported, sent } = gatewayEnvironment({
    domain: GatewayDomain.make("gw.internal"),
    llmProviders,
    ghConfigDirectory: "/home/usine/.usine/workers/eu-one/gh",
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

describe("An Attempt's environment behind a Gateway", () => {
  it("points git, gh, and package managers at the Gateway, with the caller token only in what is sent", () => {
    const { exported, sent } = environmentFor([]);
    assert.deepStrictEqual(exported, WITHOUT_LLM);
    assert.deepStrictEqual(sent, {
      GIT_CONFIG_VALUE_0: `x-usine-gateway-token: ${CALLER_TOKEN}`,
      GH_ENTERPRISE_TOKEN: CALLER_TOKEN,
      GH_TOKEN: CALLER_TOKEN,
    });
    assert.notInclude(JSON.stringify(exported), CALLER_TOKEN);
  });

  it("points Claude Code at the Gateway only when the Gateway holds the Anthropic credential", () => {
    const { exported, sent } = environmentFor(["anthropic"]);
    assert.deepStrictEqual(exported, {
      ...WITHOUT_LLM,
      ANTHROPIC_BASE_URL: "http://llm.gw.internal/anthropic",
    });
    assert.deepStrictEqual(sent, {
      GIT_CONFIG_VALUE_0: `x-usine-gateway-token: ${CALLER_TOKEN}`,
      GH_ENTERPRISE_TOKEN: CALLER_TOKEN,
      GH_TOKEN: CALLER_TOKEN,
      ANTHROPIC_AUTH_TOKEN: CALLER_TOKEN,
    });
    assert.deepStrictEqual(Object.keys(sent), [...GATEWAY_SENT_VARIABLES]);
  });
});
