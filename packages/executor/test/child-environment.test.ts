import { assert, describe, it } from "@effect/vitest";
import { BotAccount, BotLogin, BotUserId } from "@usine/core/worker";
import { Option } from "effect";
import { childEnvironment } from "../src/child-environment.ts";

const author = new BotAccount({
  login: BotLogin.make("usine-phildl[bot]"),
  id: BotUserId.make(323694641),
});

describe("childEnvironment", () => {
  it("sets bot identity and hooks and overrides inherited Claude connector and traffic settings", () => {
    const environment = childEnvironment(
      {
        GIT_AUTHOR_NAME: "Operator",
        ENABLE_CLAUDEAI_MCP_SERVERS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
      },
      author,
      Option.some("/attempt/.git/usine-hooks"),
    );
    const email = "323694641+usine-phildl[bot]@users.noreply.github.com";
    assert.deepStrictEqual(environment, {
      GIT_AUTHOR_NAME: "usine-phildl[bot]",
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: "usine-phildl[bot]",
      GIT_COMMITTER_EMAIL: email,
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/attempt/.git/usine-hooks",
    });
  });
});
