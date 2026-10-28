import type { BotAccount } from "@usine/core/worker";
import type { Option } from "effect";
import { withGitHooks } from "./pre-push-hook.ts";

/**
 * Returns the variables that make `author` the author and committer of every commit git makes
 * with them. They take precedence over `user.name` and `user.email` in every git config,
 * including the Worker user's global one.
 */
export const commitIdentity = (author: BotAccount) =>
  ({
    GIT_AUTHOR_NAME: author.login,
    GIT_AUTHOR_EMAIL: author.noreplyEmail,
    GIT_COMMITTER_NAME: author.login,
    GIT_COMMITTER_EMAIL: author.noreplyEmail,
  }) satisfies Record<string, string>;

/**
 * Returns the environment for an Attempt's parent and children on every Worker kind:
 * `environment`, with the commit identity, Git trace file, and optional hooks directory.
 */
export const childEnvironment = (
  environment: Readonly<Record<string, string>>,
  author: BotAccount,
  gitHooks: Option.Option<string>,
  gitTrace: string,
): Record<string, string> =>
  withGitHooks({ ...environment, ...commitIdentity(author), GIT_TRACE2_EVENT: gitTrace }, gitHooks);
