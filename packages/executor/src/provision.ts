import type { AttemptFailure } from "@usine/core/attempt/failure";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  type AttemptRecovery,
  type AttemptSalvage,
  SalvagePushed,
} from "@usine/core/attempt/salvage";
import { RepositoryName, CommitSha, safeSegment } from "@usine/core/repository";
import { Deferred, Effect, Exit, Option, Ref, Result, Schema } from "effect";
import {
  ExecutorOperationError,
  AttemptWorkspace,
  WorktreePath,
  type CheckoutRequest,
} from "./executor.ts";
import { salvageWorktree } from "./salvage.ts";

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
  /** Waits for the workspace scope to close; none after a successful Attempt or a clean worktree. */
  readonly salvaged: Effect.Effect<Option.Option<AttemptSalvage>, AttemptFailure>;
  /** Installs durable recording before launch; cleanup keeps unrecorded salvage on disk. */
  readonly recordSalvage: (record: AttemptChannel.Sink["salvage"]) => Effect.Effect<void>;
  /**
   * Leaves the checkout untouched when the scope closes without success: the
   * Attempt's parent task outlives this process and reattaches to it after a restart.
   */
  readonly keepForReattach: Effect.Effect<void>;
}

interface ReleaseOptions<E> {
  readonly request: CheckoutRequest;
  readonly host: string;
  readonly layout: Pick<WorkspaceLayout, "cache" | "worktree">;
  readonly ops: Pick<WorkspaceOps<E>, "cacheExists" | "git" | "removePath">;
}

/** Runs one cleanup step, logging and dropping its failure so the remaining steps still release their resources. */
const cleanupFor =
  <E>(options: Pick<ReleaseOptions<E>, "request" | "host" | "layout">) =>
  <A>(resource: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.logError("Attempt cleanup operation failed", {
          attemptId: options.request.attemptId,
          worker: options.request.worker,
          host: options.host,
          worktree: options.layout.worktree,
          resource,
          message: String(error),
        }),
      ),
      Effect.ignore,
    );

/**
 * Registers the one finalizer that owns an Attempt checkout's exit: closing the
 * scope with anything but a success exit salvages a checked-out worktree before
 * removing it, and a worktree whose salvage did not preserve all work stays on
 * disk. `checkedOut` holds the checkout's base once a worktree exists.
 */
const registerRelease = Effect.fn("Executor.registerRelease")(function* <E extends Error>(
  options: ReleaseOptions<E>,
) {
  const { layout, ops, request } = options;
  const checkedOut = yield* Ref.make(Option.none<CommitSha>());
  const salvaged = yield* Deferred.make<Option.Option<AttemptSalvage>, AttemptFailure>();
  const recorder = yield* Ref.make(Option.none<AttemptChannel.Sink["salvage"]>());
  const cleanup = cleanupFor(options);
  const kept = yield* Ref.make(false);
  // The exit is the Attempt's: a success exit means the Attempt delivered its result.
  yield* Effect.addFinalizer(
    Effect.fn("Executor.releaseWorktree")(function* (exit) {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
        host: options.host,
      });
      if (!Exit.isSuccess(exit) && (yield* Ref.get(kept))) {
        yield* Deferred.succeed(salvaged, Option.none());
        yield* Effect.logInfo("Leaving the checkout in place for the Attempt's reattachment", {
          attemptId: request.attemptId,
          worker: request.worker,
          host: options.host,
          worktree: layout.worktree,
        });
        return;
      }
      const baseCommit = yield* Ref.get(checkedOut);
      const salvage =
        Option.isSome(baseCommit) && !Exit.isSuccess(exit)
          ? yield* salvageWorktree({
              attemptId: request.attemptId,
              worker: request.worker,
              host: options.host,
              worktree: layout.worktree,
              baseCommit,
              ref: request.salvageRef,
              git: (args) => ops.git("cleanup", args),
            })
          : Option.none<AttemptSalvage>();
      if (Option.isSome(salvage)) {
        const record = yield* Ref.get(recorder);
        if (Option.isNone(record)) {
          yield* Deferred.succeed(salvaged, salvage);
          yield* Effect.logWarning("Attempt worktree retained; no salvage recorder installed", {
            attemptId: request.attemptId,
            worktree: layout.worktree,
          });
          return;
        }
        const recorded = yield* Effect.result(record.value(salvage.value));
        if (Result.isFailure(recorded)) {
          yield* Deferred.fail(salvaged, recorded.failure);
          yield* Effect.logError("Attempt salvage could not be recorded; checkout retained", {
            attemptId: request.attemptId,
            worktree: layout.worktree,
            errorTag: recorded.failure._tag,
          });
          return;
        }
      }
      yield* Deferred.succeed(salvaged, salvage);
      if (Option.exists(salvage, ({ _tag }) => _tag === "Retained")) {
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
  return {
    checkedOut,
    salvaged: Deferred.await(salvaged),
    recordSalvage: (record: AttemptChannel.Sink["salvage"]) =>
      Ref.set(recorder, Option.some(record)),
    keepForReattach: Ref.set(kept, true),
  };
});

/**
 * The clone-to-worktree sequence every Executor shares: clone into a staging
 * sibling and promote it on success, so an interrupted clone never leaves a
 * half-initialized cache that later fetches would poison; then fetch the
 * requested revision and check out a detached worktree at the resolved commit,
 * or at the previous Attempt's salvage when the request resumes one. The
 * checkout's release finalizer is registered before the first mutation.
 */
export const provisionWorktree = Effect.fn("Executor.provisionWorktree")(function* <
  E extends Error,
>(options: ProvisionOptions<E>) {
  const { layout, ops, request } = options;
  yield* Effect.annotateCurrentSpan({
    attemptId: request.attemptId,
    worker: request.worker,
    host: options.host,
    repository: request.repository,
  });
  // Register before any filesystem mutation. This also covers failed worktree
  // creation, which can leave both a directory and a bare-cache registration.
  const release = yield* registerRelease(options);
  const cleanup = cleanupFor(options);
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
  yield* Ref.set(release.checkedOut, Option.some(baseCommit));
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
    salvaged: release.salvaged,
    recordSalvage: release.recordSalvage,
    keepForReattach: release.keepForReattach,
  } satisfies ProvisionedWorktree;
});

export interface ReattachOptions<E> extends ReleaseOptions<E> {
  /** The RunSpec the Attempt's parent started with, read back from its checkout. */
  readonly spec: AttemptChannel.RunSpec;
}

/**
 * Takes over the checkout an Attempt still holds after an orchestrator restart,
 * for its reattachment: nothing is cloned, fetched, or checked out, and the
 * same release as a fresh checkout salvages and removes it when the Attempt ends.
 */
export const reattachWorktree = Effect.fn("Executor.reattachWorktree")(function* <E extends Error>(
  options: ReattachOptions<E>,
) {
  const { layout, request, spec } = options;
  yield* Effect.annotateCurrentSpan({
    attemptId: request.attemptId,
    worker: request.worker,
    host: options.host,
    repository: request.repository,
  });
  const release = yield* registerRelease(options);
  yield* Ref.set(release.checkedOut, Option.some(spec.baseCommit));
  return {
    workspace: new AttemptWorkspace({
      worker: request.worker,
      spec,
      worktree: WorktreePath.make(layout.worktree),
    }),
    salvaged: release.salvaged,
    recordSalvage: release.recordSalvage,
    keepForReattach: release.keepForReattach,
  } satisfies ProvisionedWorktree;
});

export interface RecoveryOptions<E> {
  readonly attempt: AttemptRecovery;
  readonly host: string;
  readonly worktree: string;
  readonly cache: string;
  /** Runs git with the Worker's repository credentials. */
  readonly git: (args: ReadonlyArray<string>) => Effect.Effect<string, E>;
}

/**
 * Reconciles a checkout an earlier process left behind: salvages it without a
 * known base, records the outcome, and removes the worktree only once its work
 * is published. A retained worktree stays for the next reconciliation. A
 * succeeded Attempt already delivered its result, so its checkout is removed
 * without salvage.
 */
export const recoverWorktree = Effect.fn("Executor.recoverWorktree")(function* <
  E extends Error,
  RecordError,
>(
  options: RecoveryOptions<E>,
  record: (salvage: AttemptSalvage) => Effect.Effect<void, RecordError>,
) {
  const { attempt, host, worktree } = options;
  yield* Effect.annotateCurrentSpan({ ...attempt, host, worktree });
  if (attempt.succeeded) {
    yield* options.git(["--git-dir", options.cache, "worktree", "remove", "--force", worktree]);
    yield* Effect.logInfo("Released the checkout of a succeeded Attempt", {
      ...attempt,
      host,
      worktree,
    });
    return;
  }
  const salvage = yield* salvageWorktree({
    ...attempt,
    host,
    worktree,
    baseCommit: Option.none(),
    git: options.git,
  });
  if (Option.isNone(salvage)) return;
  yield* record(salvage.value);
  if (salvage.value._tag === "Retained") return;
  yield* options.git(["--git-dir", options.cache, "worktree", "remove", "--force", worktree]);
  yield* Effect.logInfo("Reconciled and released Attempt salvage", { ...attempt, host, worktree });
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
  const ref = `refs/heads/${resume.value.ref}`;
  const advertised = yield* ops.git("prepare", [
    "--git-dir",
    layout.cache,
    "ls-remote",
    "--heads",
    "origin",
    ref,
  ]);
  if (advertised.trim() === "") {
    yield* Effect.logWarning(
      "Salvage ref deleted; the Attempt starts from its base revision",
      fields,
    );
    return Option.none<SalvagePushed>();
  }
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
      Effect.flatMap((output) =>
        decodeCommit(output.trim()).pipe(
          Effect.mapError(
            (cause) =>
              new ExecutorOperationError({
                operation: "prepare",
                message: "git returned an invalid salvage object id",
                cause,
              }),
          ),
        ),
      ),
    );
  if (fetched !== resume.value.commit) {
    yield* Effect.logWarning("Salvage ref moved since it was recorded; resuming from its head", {
      ...fields,
      recorded: resume.value.commit,
      current: fetched,
    });
  }
  yield* Effect.logInfo("Resuming the Attempt from the previous salvage", {
    ...fields,
    commit: fetched,
  });
  return Option.some(new SalvagePushed({ ref: resume.value.ref, commit: fetched }));
});
