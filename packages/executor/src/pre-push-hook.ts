import type { LoopName } from "@usine/core/loop";
import { Option } from "effect";

/**
 * The directory inside a checkout's own git directory that holds the hooks
 * of an Attempt whose Loop has `permissions: read`. `git worktree remove`
 * deletes it with the checkout.
 */
export const PRE_PUSH_HOOKS_DIRECTORY = "usine-hooks";

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** What a push from the checkout of an Attempt of `loop`, a Loop with `permissions: read`, prints. */
const pushRefusal = (loop: LoopName): string =>
  `usine refused this push: the Loop ${loop} has permissions: read, so its Attempts cannot push to the repository.`;

/**
 * A pre-push hook that stops every push from the checkout of an Attempt of
 * `loop` with `pushRefusal`, so the Agent reads why its push failed instead
 * of GitHub's 403. It is a courtesy, not a control: `git push --no-verify`
 * skips it, and what refuses the push is the Attempt's token, which has
 * `contents: read` (ADR 0011).
 */
export const prePushHook = (loop: LoopName): string =>
  `#!/bin/sh\necho ${quote(pushRefusal(loop))} >&2\nexit 1\n`;

/**
 * `environment` with git told to run hooks from `hooks`, when there is one.
 * The setting is appended after the configuration entries `environment`
 * already sets through `GIT_CONFIG_COUNT`, and configuration from the
 * environment wins over the repository's own, so the hook also runs when the
 * repository sets its own `core.hooksPath`.
 */
export const withGitHooks = (
  environment: Readonly<Record<string, string>>,
  hooks: Option.Option<string>,
): Record<string, string> =>
  Option.match(hooks, {
    onNone: () => ({ ...environment }),
    onSome: (directory) => {
      const index = Number(environment.GIT_CONFIG_COUNT ?? "0");
      return {
        ...environment,
        GIT_CONFIG_COUNT: String(index + 1),
        [`GIT_CONFIG_KEY_${index}`]: "core.hooksPath",
        [`GIT_CONFIG_VALUE_${index}`]: directory,
      };
    },
  });
