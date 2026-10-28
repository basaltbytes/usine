import { assert, describe, it } from "@effect/vitest";
import { BotAccount, BotLogin, BotUserId } from "@usine/core/worker";
import { Option } from "effect";
import { childEnvironment } from "../src/child-environment.ts";

const author = new BotAccount({
  login: BotLogin.make("usine-phildl[bot]"),
  id: BotUserId.make(323694641),
});

describe("childEnvironment", () => {
  it("makes the bot account the author and committer and adds the hooks directory last", () => {
    const environment = childEnvironment(
      {
        GIT_AUTHOR_NAME: "Operator",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
      },
      author,
      Option.some("/attempt/.git/usine-hooks"),
      "/attempt/.git/usine-git-trace.jsonl",
    );
    const email = "323694641+usine-phildl[bot]@users.noreply.github.com";
    assert.deepStrictEqual(environment, {
      GIT_TRACE2_EVENT: "/attempt/.git/usine-git-trace.jsonl",
      GIT_AUTHOR_NAME: "usine-phildl[bot]",
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: "usine-phildl[bot]",
      GIT_COMMITTER_EMAIL: email,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/attempt/.git/usine-hooks",
    });
  });
});
