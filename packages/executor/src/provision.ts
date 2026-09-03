import { AttemptChannel, Repository } from "@usine/core";
import { Effect, Schema } from "effect";
import {
  ExecutorOperationError,
  PreparedAttempt,
  WorktreePath,
  type CheckoutRequest,
} from "./index.ts";

export const safeSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

const CACHE_DIRECTORY_SUFFIX = ".git";

/** The bare cache directory name every adapter mints for a repository under `repos/`. */
export const cacheDirectoryName = (repository: Repository.Name): string =>
  `${safeSegment(repository)}${CACHE_DIRECTORY_SUFFIX}`;

/**
 * Whether a `repos/` entry is one of our bare caches, decided by the name we
 * mint rather than by probing its contents: a `HEAD` lookup fails with
 * ENOTDIR on a stray file, and a `.cloning` staging leftover or a tool's
 * scratch directory must never be handed to `git worktree prune`.
 */
export const isCacheDirectoryName = (entry: string): boolean =>
  entry.length > CACHE_DIRECTORY_SUFFIX.length && entry.endsWith(CACHE_DIRECTORY_SUFFIX);

const decodeCommit = Schema.decodeUnknownEffect(Repository.CommitSha);

export interface WorkspaceLayout {
  readonly cache: string;
  readonly staging: string;
  readonly worktree: string;
}

/** The adapter-specific primitives; everything else about provisioning is shared. */
export interface WorkspaceOps<E> {
  readonly ensureRoots: Effect.Effect<void, E>;
  readonly removePath: (target: string) => Effect.Effect<void, E>;
  readonly cacheExists: Effect.Effect<boolean, E>;
  /** Atomically promote the finished staging clone to the cache path. */
  readonly promoteStaging: Effect.Effect<void, E>;
  readonly git: (args: ReadonlyArray<string>) => Effect.Effect<string, E>;
}

export interface ProvisionOptions<E> {
  readonly request: CheckoutRequest;
  readonly url: string;
  readonly host: string;
  readonly layout: WorkspaceLayout;
  readonly ops: WorkspaceOps<E>;
}

/**
 * One canonical cached-clone-to-worktree choreography shared by every
 * Executor: clone into a staging sibling and promote on success (an
 * interrupted clone must never leave a half-initialized cache that every
 * later fetch for the repository would poison), fetch the requested
 * revision, and check out a detached worktree at the resolved commit.
 */
export const provisionWorktree = Effect.fn("Executor.provisionWorktree")(function* <E>(
  options: ProvisionOptions<E>,
) {
  const { layout, ops, request } = options;
  yield* Effect.annotateCurrentSpan({
    attemptId: request.attemptId,
    worker: request.worker,
    host: options.host,
    repository: request.repository,
  });
  yield* ops.ensureRoots;
  yield* ops.removePath(layout.worktree);
  if (yield* ops.cacheExists) {
    yield* ops.git(["--git-dir", layout.cache, "remote", "set-url", "origin", options.url]);
  } else {
    yield* ops.removePath(layout.staging);
    yield* ops.git(["clone", "--bare", "--filter=blob:none", options.url, layout.staging]).pipe(
      Effect.onError(() =>
        ops.removePath(layout.staging).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not remove a partial clone", {
              attemptId: request.attemptId,
              worker: request.worker,
              host: options.host,
              staging: layout.staging,
              message: String(error),
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
    yield* ops.promoteStaging;
  }
  yield* ops.git([
    "--git-dir",
    layout.cache,
    "fetch",
    "--force",
    "--prune",
    "origin",
    request.revision,
  ]);
  const resolved = (yield* ops.git(["--git-dir", layout.cache, "rev-parse", "FETCH_HEAD"])).trim();
  const baseCommit = yield* decodeCommit(resolved).pipe(
    Effect.mapError(
      (cause) =>
        new ExecutorOperationError({
          operation: "prepare",
          message: "git returned an invalid object id",
          cause,
        }),
    ),
  );
  yield* ops.git([
    "--git-dir",
    layout.cache,
    "worktree",
    "add",
    "--detach",
    layout.worktree,
    baseCommit,
  ]);
  return new PreparedAttempt({
    worker: request.worker,
    spec: new AttemptChannel.RunSpec({
      attemptId: request.attemptId,
      repository: request.repository,
      revision: request.revision,
      baseCommit,
      payload: request.payload,
      task: request.task,
      agent: request.agent,
      parentModel: request.parentModel,
      parentEffort: request.parentEffort,
    }),
    worktree: WorktreePath.make(layout.worktree),
  });
});
