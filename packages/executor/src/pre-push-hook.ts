import type { LoopName } from "@usine/core/loop";
import { Option } from "effect";

/**
 * The hooks directory inside the checkout's git directory for `permissions: read` Loops.
 * `git worktree remove` deletes it with the checkout.
 */
export const PRE_PUSH_HOOKS_DIRECTORY = "usine-hooks";

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Returns the message printed when a push from a `permissions: read` checkout is rejected. */
const pushRefusal = (loop: LoopName): string =>
  `usine refused this push: the Loop ${loop} has permissions: read, so its Attempts cannot push to the repository.`;

/**
 * Returns a pre-push hook that rejects every push with `pushRefusal`, so the Agent sees the
 * reason instead of GitHub's 403. `git push --no-verify` skips it; the `contents: read` token is
 * what blocks the push (ADR 0011).
 */
export const prePushHook = (loop: LoopName): string =>
  `#!/bin/sh\necho ${quote(pushRefusal(loop))} >&2\nexit 1\n`;

/**
 * Returns `environment` with `core.hooksPath` set to `hooks`, if any, after the entries counted
 * in `GIT_CONFIG_COUNT`. Environment config overrides repository config, so the hook runs even
 * if the repository sets `core.hooksPath`.
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
