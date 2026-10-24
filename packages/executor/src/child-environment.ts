import type { BotAccount } from "@usine/core/worker";
import type { Option } from "effect";
import { withGitHooks } from "./pre-push-hook.ts";

/**
 * Returns the environment for an Attempt's parent and children on every Worker kind:
 * `environment`, with `author` as the author and committer of every commit, and with `gitHooks`
 * as `core.hooksPath` if set. The identity variables take precedence over `user.name` and
 * `user.email` in every git config, including the Worker user's global one.
 */
export const childEnvironment = (
  environment: Readonly<Record<string, string>>,
  author: BotAccount,
  gitHooks: Option.Option<string>,
): Record<string, string> =>
  withGitHooks(
    {
      ...environment,
      GIT_AUTHOR_NAME: author.login,
      GIT_AUTHOR_EMAIL: author.noreplyEmail,
      GIT_COMMITTER_NAME: author.login,
      GIT_COMMITTER_EMAIL: author.noreplyEmail,
    },
    gitHooks,
  );
