import type { AttemptId } from "@usine/core/attempt";
import {
  type AttemptSalvage,
  type SalvageRef,
  SalvagePushed,
  SalvageRejected,
  SalvageRetained,
} from "@usine/core/attempt/salvage";
import { CommitSha } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import { Effect, Option, Result, Schema } from "effect";

const PUSH_TIMEOUT = "2 minutes";

/** GitHub refuses a push with a file larger than 100 MiB. */
const GITHUB_FILE_LIMIT_BYTES = 100 * 1024 * 1024;

/** GitHub's code for a push refused for a file over its size limit, in the push's stderr. */
const LARGE_FILES_REFUSAL = /\bGH001\b/u;

/** The package stores and build caches that the salvage commit leaves out at any depth. */
const CACHE_DIRECTORIES = [".pnpm-store", "node_modules", ".turbo"];

const CACHE_PATHS = CACHE_DIRECTORIES.map((directory) => `:(glob)**/${directory}/**`);

/**
 * The checkout's paths that the salvage commits: everything that Git doesn't ignore, except
 * package stores and build caches.
 */
const SALVAGED_PATHS = [
  ".",
  ...CACHE_DIRECTORIES.map((directory) => `:(exclude,glob)**/${directory}/**`),
];

export interface SalvageOptions<E extends Error> {
  readonly attemptId: AttemptId;
  readonly worker: WorkerName;
  readonly host: string;
  readonly worktree: string;
  readonly baseCommit: Option.Option<CommitSha>;
  readonly ref: SalvageRef;
  /** An earlier salvage that the remote rejected; its commit isn't pushed again. */
  readonly rejected: Option.Option<SalvageRejected>;
  /**
   * Runs git with the Worker's repository credentials and the Attempt's `commitIdentity`, which
   * authors and commits the salvage commit. `salvageWorktree` prepends `-C <worktree>`.
   */
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

/** A staged file larger than GitHub accepts, with its size in bytes. */
interface OversizedFile {
  readonly path: string;
  readonly size: number;
}

/**
 * Returns the staged files in the `ls-tree -r -l -z` listing of the index's tree that are larger
 * than GitHub accepts.
 */
const oversizedIn = (listing: string, staged: ReadonlySet<string>): ReadonlyArray<OversizedFile> =>
  listing.split("\0").flatMap((entry) => {
    // <mode> SP <type> SP <object> SP <padded size> TAB <path>
    const tab = entry.indexOf("\t");
    if (tab < 0) return [];
    const [, type, , size] = entry.slice(0, tab).split(/ +/u);
    const path = entry.slice(tab + 1);
    return type === "blob" && Number(size) > GITHUB_FILE_LIMIT_BYTES && staged.has(path)
      ? [{ path, size: Number(size) }]
      : [];
  });

/**
 * Commits the changes in an unsuccessful Attempt's checkout and pushes HEAD to its salvage ref
 * before the worktree is removed. The commit leaves out what Git ignores, package stores and
 * build caches even if the Attempt staged them, and files larger than GitHub accepts. Skips a checkout with nothing to push beyond its
 * base commit, or whose commit the remote rejected in `rejected`. If the push fails, keeps the
 * worktree and reports its path. Never fails; skipped and failed stages are logged.
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
    status: git(["status", "--porcelain", "--untracked-files=all", "--", ...SALVAGED_PATHS]),
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

  /**
   * Stages the salvaged paths without the files larger than GitHub accepts, and returns the
   * number of staged changes.
   */
  const stage = Effect.gen(function* () {
    yield* git(["add", "--all", "--", ...SALVAGED_PATHS]);
    // Exclusion pathspecs don't unstage the caches that the Attempt's own `git add` staged.
    yield* git(["reset", "--quiet", "--", ...CACHE_PATHS]);
    const staged = (yield* git(["diff", "--cached", "--name-only", "--no-renames", "-z"]))
      .split("\0")
      .filter((path) => path.length > 0);
    if (staged.length === 0) return 0;
    const tree = (yield* git(["write-tree"])).trim();
    const oversized = oversizedIn(yield* git(["ls-tree", "-r", "-l", "-z", tree]), new Set(staged));
    if (oversized.length > 0) {
      yield* git([
        "--literal-pathspecs",
        "reset",
        "--quiet",
        "--",
        ...oversized.map(({ path }) => path),
      ]);
      yield* Effect.logWarning(
        "Left files larger than GitHub's 100 MiB limit out of the salvage commit",
        {
          ...fields,
          files: oversized
            .map(({ path, size }) => `${path} (${(size / 1024 / 1024).toFixed(1)} MiB)`)
            .join(", "),
        },
      );
    }
    return staged.length - oversized.length;
  });

  let commit = inspected.success.head;
  if (dirty) {
    const committed = yield* stage.pipe(
      Effect.flatMap((staged) =>
        staged === 0
          ? Effect.succeed(commit)
          : git([
              "-c",
              "commit.gpgsign=false",
              "commit",
              "--quiet",
              "--no-verify",
              "--message",
              `wip(usine): salvage attempt ${options.attemptId}`,
            ]).pipe(Effect.andThen(head())),
      ),
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
  if (Option.contains(options.baseCommit, commit)) {
    yield* Effect.logInfo("Nothing to salvage from the Attempt worktree", fields);
    return Option.none<AttemptSalvage>();
  }
  const rejected = Option.filter(options.rejected, (salvage) => salvage.commit === commit);
  if (Option.isSome(rejected)) {
    yield* Effect.logInfo(
      "The remote rejected this salvage commit before; retaining the Attempt worktree without pushing it again",
      { ...fields, ref: options.ref, commit },
    );
    return Option.some<AttemptSalvage>(rejected.value);
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
        onNone: () => Option.some(`git push didn't finish within ${PUSH_TIMEOUT}`),
        onSome: () => Option.none<string>(),
      }),
    }),
  );
  if (Option.isSome(pushFailure)) {
    const message = pushFailure.value;
    if (LARGE_FILES_REFUSAL.test(message)) {
      yield* Effect.logError(
        "GitHub refused the salvage push for a file over its size limit; retaining the Attempt worktree, which recovery doesn't push again until its commit changes",
        { ...fields, ref: options.ref, commit, message },
      );
      return Option.some<AttemptSalvage>(
        new SalvageRejected({ path: options.worktree, commit, message }),
      );
    }
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
