import type { AttemptId } from "@usine/core/attempt";
import {
  type AttemptSalvage,
  type SalvageRef,
  SalvagePushed,
  SalvageRetained,
} from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import { Effect, Option, Result, Schema } from "effect";

const PUSH_TIMEOUT = "2 minutes";
/** The git identity for commits usine creates in an Attempt's worktree. */
export const SALVAGE_GIT_CONFIG = [
  "-c",
  "user.name=usine",
  "-c",
  "user.email=usine@basaltbytes.dev",
  "-c",
  "commit.gpgsign=false",
];

export interface SalvageOptions<E extends Error> {
  readonly attemptId: AttemptId;
  readonly worker: WorkerName;
  readonly host: string;
  readonly worktree: string;
  readonly baseCommit: Option.Option<CommitSha>;
  readonly ref: SalvageRef;
  /** Runs git with the Worker's repository credentials; `salvageWorktree` prepends `-C <worktree>`. */
  readonly git: (args: ReadonlyArray<string>) => Effect.Effect<string, E>;
}

const decodeCommit = Schema.decodeUnknownEffect(CommitSha);

/**
 * Returns the operator-facing line for the run drawer: the failure's message followed by its
 * cause's message. For a failed command, the cause is the stderr, which local and SSH executors
 * scrub of the Attempt's token.
 */
export const failureMessage = (failure: Error): string => {
  const detail = failure.cause instanceof Error ? failure.cause.message.trim() : "";
  return detail.length === 0 ? failure.message : `${failure.message}: ${detail}`;
};

/**
 * Commits everything in an unsuccessful Attempt's checkout and pushes HEAD to its salvage ref
 * before the worktree is removed. Skips a clean checkout at its base commit. If the push fails,
 * keeps the worktree and reports its path. Never fails; skipped and failed stages are logged.
 */
export const salvageWorktree = Effect.fn("Executor.salvageWorktree")(function* <E extends Error>(
  options: SalvageOptions<E>,
) {
  const fields = {
    attemptId: options.attemptId,
    worker: options.worker,
    host: options.host,
    worktree: options.worktree,
  };
  yield* Effect.annotateCurrentSpan(fields);
  const git = (args: ReadonlyArray<string>) => options.git(["-C", options.worktree, ...args]);
  const head = () =>
    git(["rev-parse", "HEAD"]).pipe(Effect.flatMap((output) => decodeCommit(output.trim())));

  const inspected = yield* Effect.all({
    head: head(),
    status: git(["status", "--porcelain", "--untracked-files=all"]),
  }).pipe(Effect.result);
  if (Result.isFailure(inspected)) {
    const message = failureMessage(inspected.failure);
    yield* Effect.logError("Could not inspect the Attempt worktree for salvage", {
      ...fields,
      message,
    });
    return Option.some<AttemptSalvage>(
      new SalvageRetained({ path: options.worktree, commit: options.baseCommit, message }),
    );
  }
  const dirty = inspected.success.status.trim().length > 0;
  if (!dirty && Option.contains(options.baseCommit, inspected.success.head)) {
    yield* Effect.logInfo("Nothing to salvage from the Attempt worktree", fields);
    return Option.none<AttemptSalvage>();
  }

  let commit = inspected.success.head;
  if (dirty) {
    const committed = yield* git(["add", "--all"]).pipe(
      Effect.andThen(
        git([
          ...SALVAGE_GIT_CONFIG,
          "commit",
          "--quiet",
          "--no-verify",
          "--message",
          `wip(usine): salvage attempt ${options.attemptId}`,
        ]),
      ),
      Effect.andThen(head()),
      Effect.result,
    );
    if (Result.isFailure(committed)) {
      const message = failureMessage(committed.failure);
      yield* Effect.logError("Could not commit the Attempt's uncommitted changes", {
        ...fields,
        message,
      });
      return Option.some<AttemptSalvage>(
        new SalvageRetained({ path: options.worktree, commit: Option.some(commit), message }),
      );
    } else {
      commit = committed.success;
    }
  }

  const pushFailure = yield* git([
    "push",
    "--force",
    "--no-verify",
    "origin",
    `${commit}:refs/heads/${options.ref}`,
  ]).pipe(
    Effect.timeoutOption(PUSH_TIMEOUT),
    Effect.match({
      onFailure: (failure) => Option.some(failureMessage(failure)),
      onSuccess: Option.match({
        onNone: () => Option.some(`git push did not finish within ${PUSH_TIMEOUT}`),
        onSome: () => Option.none<string>(),
      }),
    }),
  );
  if (Option.isSome(pushFailure)) {
    const message = pushFailure.value;
    yield* Effect.logError("Salvage push failed; retaining the Attempt worktree", {
      ...fields,
      ref: options.ref,
      commit,
      message,
    });
    return Option.some<AttemptSalvage>(
      new SalvageRetained({ path: options.worktree, commit: Option.some(commit), message }),
    );
  }
  yield* Effect.logInfo("Salvaged the Attempt's work", { ...fields, ref: options.ref, commit });
  return Option.some<AttemptSalvage>(new SalvagePushed({ ref: options.ref, commit }));
});
