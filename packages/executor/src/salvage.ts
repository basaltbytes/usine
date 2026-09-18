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

/** Bounds the salvage push so a stalled remote cannot hold the Attempt's cleanup open. */
const PUSH_TIMEOUT = "2 minutes";
const SALVAGE_AUTHOR = [
  "-c",
  "user.name=usine",
  "-c",
  "user.email=usine@basaltbytes.dev",
  "-c",
  "commit.gpgsign=false",
];

export interface SalvageOptions<E> {
  readonly attemptId: AttemptId;
  readonly worker: WorkerName;
  readonly host: string;
  readonly worktree: string;
  readonly baseCommit: CommitSha;
  readonly ref: SalvageRef;
  /** Runs git with the Worker's repository credentials; the salvage adds the worktree itself. */
  readonly git: (args: ReadonlyArray<string>) => Effect.Effect<string, E>;
}

const decodeCommit = Schema.decodeUnknownEffect(CommitSha);

/**
 * Preserves an unsuccessful Attempt's work before its worktree is removed:
 * commits everything left in the checkout and pushes HEAD to the Attempt's
 * salvage ref. A clean checkout at its base commit has nothing to salvage. A
 * failed push retains the worktree and reports its path instead. Never fails;
 * every skipped or failed stage is logged.
 */
export const salvageWorktree = Effect.fn("Executor.salvageWorktree")(function* <E>(
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
    yield* Effect.logError("Could not inspect the Attempt worktree for salvage", {
      ...fields,
      message: String(inspected.failure),
    });
    return Option.none<AttemptSalvage>();
  }
  const dirty = inspected.success.status.trim().length > 0;
  if (!dirty && inspected.success.head === options.baseCommit) {
    yield* Effect.logInfo("Nothing to salvage from the Attempt worktree", fields);
    return Option.none<AttemptSalvage>();
  }

  let commit = inspected.success.head;
  if (dirty) {
    const committed = yield* git(["add", "--all"]).pipe(
      Effect.andThen(
        git([
          ...SALVAGE_AUTHOR,
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
      yield* Effect.logError("Could not commit the Attempt's uncommitted changes", {
        ...fields,
        message: String(committed.failure),
      });
      if (commit === options.baseCommit) return Option.none<AttemptSalvage>();
    } else {
      commit = committed.success;
    }
  }

  const pushed = yield* git([
    "push",
    "--force",
    "--no-verify",
    "origin",
    `${commit}:refs/heads/${options.ref}`,
  ]).pipe(
    Effect.timeoutOption(PUSH_TIMEOUT),
    Effect.flatMap((output) =>
      Option.isNone(output) ? Effect.fail(new Error("push timed out")) : Effect.void,
    ),
    Effect.result,
  );
  if (Result.isFailure(pushed)) {
    const message = String(pushed.failure);
    yield* Effect.logError("Salvage push failed; retaining the Attempt worktree", {
      ...fields,
      ref: options.ref,
      commit,
      message,
    });
    return Option.some<AttemptSalvage>(
      new SalvageRetained({ path: options.worktree, commit, message }),
    );
  }
  yield* Effect.logInfo("Salvaged the Attempt's work", { ...fields, ref: options.ref, commit });
  return Option.some<AttemptSalvage>(new SalvagePushed({ ref: options.ref, commit }));
});
