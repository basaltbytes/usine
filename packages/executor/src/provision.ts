import * as AttemptChannel from "@usine/core/attempt/channel";
import { type AttemptSalvage, SalvagePushed } from "@usine/core/attempt/salvage";
import { RepositoryName, CommitSha } from "@usine/core/repository";
import { Effect, Exit, Option, Ref, Result, Schema } from "effect";
import {
  ExecutorOperationError,
  AttemptWorkspace,
  WorktreePath,
  type CheckoutRequest,
} from "./executor.ts";
import { salvageWorktree } from "./salvage.ts";

export const safeSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

const CACHE_DIRECTORY_SUFFIX = ".git";

/** The bare cache directory name for a repository under `repos/`, shared by every adapter. */
export const cacheDirectoryName = (repository: RepositoryName): string =>
  `${safeSegment(repository)}${CACHE_DIRECTORY_SUFFIX}`;

/**
 * Whether a `repos/` entry is one of our bare caches, decided by the name we
 * mint rather than by probing contents: a `HEAD` lookup fails with ENOTDIR on
 * a stray file, and a `.cloning` leftover or a tool's scratch directory must
 * never reach `git worktree prune`.
 */
export const isCacheDirectoryName = (entry: string): boolean =>
  entry.length > CACHE_DIRECTORY_SUFFIX.length && entry.endsWith(CACHE_DIRECTORY_SUFFIX);

const decodeCommit = Schema.decodeUnknownEffect(CommitSha);

interface WorkspaceLayout {
  readonly cache: string;
  readonly staging: string;
  readonly worktree: string;
}

/** The adapter-specific primitives; everything else about provisioning is shared. */
export interface WorkspaceOps<E> {
  readonly ensureRoots: Effect.Effect<void, E>;
  readonly removePath: (operation: "prepare" | "cleanup", target: string) => Effect.Effect<void, E>;
  readonly cacheExists: Effect.Effect<boolean, E>;
  /** Atomically promote the finished staging clone to the cache path. */
  readonly promoteStaging: Effect.Effect<void, E>;
  readonly git: (
    operation: "prepare" | "cleanup",
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, E>;
}

export interface ProvisionOptions<E> {
  readonly request: CheckoutRequest;
  readonly url: string;
  readonly host: string;
  readonly layout: WorkspaceLayout;
  readonly ops: WorkspaceOps<E>;
}

/** A checked-out Attempt workspace and, once its scope has closed, what the salvage step preserved. */
export interface ProvisionedWorktree {
  readonly workspace: AttemptWorkspace;
  /** None until the workspace scope closes, and after a successful Attempt or a clean worktree. */
  readonly salvaged: Effect.Effect<Option.Option<AttemptSalvage>>;
}

/**
 * The clone-to-worktree sequence every Executor shares: clone into a staging
 * sibling and promote it on success, so an interrupted clone never leaves a
 * half-initialized cache that later fetches would poison; then fetch the
 * requested revision and check out a detached worktree at the resolved commit,
 * or at the previous Attempt's salvage when the request resumes one. Closing
 * the scope with anything but a success exit salvages the worktree before
 * removing it; a worktree whose salvage push failed stays on disk.
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
  const retained = yield* Ref.make(false);
  const salvaged = yield* Ref.make(Option.none<AttemptSalvage>());
  const cleanup = <A>(resource: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.logError("Attempt cleanup operation failed", {
          attemptId: request.attemptId,
          worker: request.worker,
          host: options.host,
          worktree: layout.worktree,
          resource,
          message: String(error),
        }),
      ),
      Effect.ignore,
    );
  // Register before any filesystem mutation. This also covers failed worktree
  // creation, which can leave both a directory and a bare-cache registration.
  yield* Effect.addFinalizer(
    Effect.fn("Executor.releaseWorktree")(function* () {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
        host: options.host,
      });
      if (yield* Ref.get(retained)) {
        yield* Effect.logWarning("Attempt worktree retained; salvage did not preserve all work", {
          attemptId: request.attemptId,
          worker: request.worker,
          host: options.host,
          worktree: layout.worktree,
        });
        return;
      }
      yield* Effect.logInfo("Cleaning Attempt workspace", {
        attemptId: request.attemptId,
        worker: request.worker,
        host: options.host,
        worktree: layout.worktree,
      });
      const cacheExists = yield* ops.cacheExists.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not inspect cache during cleanup", {
            attemptId: request.attemptId,
            message: String(error),
          }),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (cacheExists) {
        yield* cleanup(
          "git-worktree",
          ops.git("cleanup", [
            "--git-dir",
            layout.cache,
            "worktree",
            "remove",
            "--force",
            layout.worktree,
          ]),
        );
      }
      yield* cleanup("worktree-directory", ops.removePath("cleanup", layout.worktree));
      if (cacheExists) {
        yield* cleanup(
          "cache-registration",
          ops.git("cleanup", ["--git-dir", layout.cache, "worktree", "prune"]),
        );
      }
    }),
  );
  yield* ops.ensureRoots;
  yield* ops.removePath("prepare", layout.worktree);
  if (yield* ops.cacheExists) {
    yield* ops.git("prepare", [
      "--git-dir",
      layout.cache,
      "remote",
      "set-url",
      "origin",
      options.url,
    ]);
  } else {
    // Staging belongs to this locked clone only. Release it before unlocking,
    // including interruption between clone completion and cache promotion.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          cleanup("partial-clone", ops.removePath("cleanup", layout.staging)),
        );
        yield* ops.removePath("prepare", layout.staging);
        yield* ops.git("prepare", [
          "clone",
          "--bare",
          "--filter=blob:none",
          options.url,
          layout.staging,
        ]);
        yield* ops.promoteStaging;
      }),
    );
  }
  yield* ops.git("prepare", [
    "--git-dir",
    layout.cache,
    "fetch",
    "--force",
    "--prune",
    "origin",
    request.revision,
  ]);
  const resolved = (yield* ops.git("prepare", [
    "--git-dir",
    layout.cache,
    "rev-parse",
    "FETCH_HEAD",
  ])).trim();
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
  const resume = yield* fetchSalvage(options, request.resume);
  yield* ops.git("prepare", [
    "--git-dir",
    layout.cache,
    "worktree",
    "add",
    "--detach",
    layout.worktree,
    Option.match(resume, { onNone: () => baseCommit, onSome: ({ commit }) => commit }),
  ]);
  // Registered after the cleanup finalizer, so it runs first. The exit is the
  // Attempt's: a success exit means the run host returned a Final result.
  yield* Effect.addFinalizer((exit) =>
    Exit.isSuccess(exit)
      ? Effect.void
      : salvageWorktree({
          attemptId: request.attemptId,
          worker: request.worker,
          host: options.host,
          worktree: layout.worktree,
          baseCommit: Option.some(baseCommit),
          ref: request.salvageRef,
          git: (args) => ops.git("cleanup", args),
        }).pipe(
          Effect.tap((salvage) => Ref.set(salvaged, salvage)),
          Effect.flatMap((salvage) =>
            Ref.set(
              retained,
              Option.exists(salvage, ({ _tag }) => _tag === "Retained"),
            ),
          ),
        ),
  );
  return {
    workspace: new AttemptWorkspace({
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
        maxChildren: request.maxChildren,
        parentEffort: request.parentEffort,
        resume,
      }),
      worktree: WorktreePath.make(layout.worktree),
    }),
    salvaged: Ref.get(salvaged),
  } satisfies ProvisionedWorktree;
});

/**
 * Fetches the previous Attempt's salvage ref into the cache. A ref that no
 * longer exists starts the Attempt from its base revision, with a warning, so
 * an operator can still retry after deleting the branch.
 */
const fetchSalvage = Effect.fn("Executor.fetchSalvage")(function* <E>(
  options: ProvisionOptions<E>,
  resume: Option.Option<SalvagePushed>,
) {
  if (Option.isNone(resume)) return Option.none<SalvagePushed>();
  const { layout, ops, request } = options;
  const fields = {
    attemptId: request.attemptId,
    worker: request.worker,
    host: options.host,
    ref: resume.value.ref,
  };
  yield* Effect.annotateCurrentSpan(fields);
  const fetched = yield* ops
    .git("prepare", [
      "--git-dir",
      layout.cache,
      "fetch",
      "--force",
      "origin",
      `refs/heads/${resume.value.ref}`,
    ])
    .pipe(
      Effect.andThen(ops.git("prepare", ["--git-dir", layout.cache, "rev-parse", "FETCH_HEAD"])),
      Effect.flatMap((output) => decodeCommit(output.trim())),
      Effect.result,
    );
  if (Result.isFailure(fetched)) {
    yield* Effect.logWarning("Salvage ref unavailable; the Attempt starts from its base revision", {
      ...fields,
      message: String(fetched.failure),
    });
    return Option.none<SalvagePushed>();
  }
  if (fetched.success !== resume.value.commit) {
    yield* Effect.logWarning("Salvage ref moved since it was recorded; resuming from its head", {
      ...fields,
      recorded: resume.value.commit,
      current: fetched.success,
    });
  }
  yield* Effect.logInfo("Resuming the Attempt from the previous salvage", {
    ...fields,
    commit: fetched.success,
  });
  return Option.some(new SalvagePushed({ ref: resume.value.ref, commit: fetched.success }));
});
