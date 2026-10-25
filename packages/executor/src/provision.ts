import type { AttemptFailure } from "@usine/core/attempt/failure";
import * as AttemptChannel from "@usine/core/attempt/channel";
import {
  type AttemptRecovery,
  type AttemptSalvage,
  SalvagePushed,
} from "@usine/core/attempt/salvage";
import { RepositoryName, CommitSha, safeSegment } from "@usine/core/repository";
import { DateTime, Deferred, Effect, Exit, Option, Ref, Result, Schema } from "effect";
import {
  ExecutorOperationError,
  AttemptWorkspace,
  WorktreePath,
  type CheckoutRequest,
} from "./executor.ts";
import { PRE_PUSH_HOOKS_DIRECTORY, prePushHook } from "./pre-push-hook.ts";
import { failureMessage, salvageWorktree } from "./salvage.ts";

const CACHE_DIRECTORY_SUFFIX = ".git";

/** Returns the bare cache directory name for `repository` under `repos/`. */
export const cacheDirectoryName = (repository: RepositoryName): string =>
  `${safeSegment(repository)}${CACHE_DIRECTORY_SUFFIX}`;

/**
 * Returns whether a `repos/` entry is a bare cache, by name only. Probing `HEAD` fails with
 * ENOTDIR on a stray file, and a `.cloning` leftover or another tool's directory must never be
 * passed to `git worktree prune`.
 */
export const isCacheDirectoryName = (entry: string): boolean =>
  entry.length > CACHE_DIRECTORY_SUFFIX.length && entry.endsWith(CACHE_DIRECTORY_SUFFIX);

const decodeCommit = Schema.decodeUnknownEffect(CommitSha);

interface WorkspaceLayout {
  readonly cache: string;
  readonly staging: string;
  readonly worktree: string;
}

/** Runs one cleanup step, and logs and ignores its failure, so later steps still run. */
export type CleanupStep<E> = <A>(
  resource: string,
  effect: Effect.Effect<A, E>,
) => Effect.Effect<void>;

/** The Attempt's checkout: how it is created and removed, and where git runs in it. */
export interface CheckoutOps<E> {
  /** Creates the checkout at the layout's worktree, detached at `commit`. */
  readonly add: (commit: CommitSha) => Effect.Effect<void, E>;
  /** Removes a checkout that `add` created during preparation, so `add` can create it again. */
  readonly discard: Effect.Effect<void, E>;
  /**
   * Runs git in the checkout with the Attempt's repository credentials and `commitIdentity` for
   * the request's `commitAuthor`, which authors the salvage commit and commits the rebased
   * salvage. `args` name the checkout with `-C`.
   */
  readonly git: (
    operation: "prepare" | "cleanup",
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, E>;
  /** Writes `content` to `path` inside the checkout, creating its directory, and makes it executable. */
  readonly writeExecutable: (path: string, content: string) => Effect.Effect<void, E>;
  /** Removes the checkout when the Attempt releases it, running each step through `cleanup`. */
  readonly remove: (cleanup: CleanupStep<E>) => Effect.Effect<void>;
}

/** Executor-specific operations for the shared provisioning code. */
export interface WorkspaceOps<E> {
  readonly ensureRoots: Effect.Effect<void, E>;
  readonly removePath: (operation: "prepare" | "cleanup", target: string) => Effect.Effect<void, E>;
  readonly cacheExists: Effect.Effect<boolean, E>;
  /** Atomically moves the finished staging clone to the cache path. */
  readonly promoteStaging: Effect.Effect<void, E>;
  /** Runs git on the cached clone with the Attempt's repository credentials. */
  readonly git: (
    operation: "prepare" | "cleanup",
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, E>;
  readonly checkout: CheckoutOps<E>;
}

/**
 * Returns the checkout as a linked worktree of the cached clone, created and removed with
 * `git worktree`. `ops.git` runs every git command, in the checkout too.
 */
export const linkedWorktree = <E>(
  ops: Pick<WorkspaceOps<E>, "cacheExists" | "git" | "removePath">,
  layout: Pick<WorkspaceLayout, "cache" | "worktree">,
  writeExecutable: (path: string, content: string) => Effect.Effect<void, E>,
): CheckoutOps<E> => ({
  add: (commit) =>
    Effect.asVoid(
      ops.git("prepare", [
        "--git-dir",
        layout.cache,
        "worktree",
        "add",
        "--detach",
        layout.worktree,
        commit,
      ]),
    ),
  discard: Effect.asVoid(
    ops.git("prepare", [
      "--git-dir",
      layout.cache,
      "worktree",
      "remove",
      "--force",
      layout.worktree,
    ]),
  ),
  git: ops.git,
  writeExecutable,
  remove: (cleanup) =>
    Effect.gen(function* () {
      const cacheExists = yield* ops.cacheExists.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not inspect cache during cleanup", {
            worktree: layout.worktree,
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
});

export interface ProvisionOptions<E> {
  readonly request: CheckoutRequest;
  readonly url: string;
  readonly host: string;
  readonly layout: WorkspaceLayout;
  readonly ops: WorkspaceOps<E>;
}

export interface ProvisionedWorktree {
  readonly workspace: AttemptWorkspace;
  /** Waits for the workspace scope to close and returns the salvage, or `None` after a successful Attempt or a clean worktree. */
  readonly salvaged: Effect.Effect<Option.Option<AttemptSalvage>, AttemptFailure>;
  /** Sets the salvage sink; call before launch. If salvage isn't recorded, cleanup keeps the worktree on disk. */
  readonly recordSalvage: (record: AttemptChannel.Sink["salvage"]) => Effect.Effect<void>;
  /**
   * Skips checkout removal when the scope closes, so a restart can reattach the parent task or
   * repeat a harvest whose result was not stored.
   */
  readonly keepForReattach: Effect.Effect<void>;
  /**
   * Skips salvage and checkout removal when the scope closes, because the parent task may still
   * run in the checkout. The executor reconciles it once a stop is confirmed (#523).
   */
  readonly keepUntilStopped: Effect.Effect<void>;
  /**
   * The hooks directory for the children's git (`withGitHooks`), set only for a
   * `permissions: read` Loop. If `None`, the repository's own hooks apply.
   */
  readonly gitHooks: Option.Option<string>;
}

interface ReleaseOptions<E> {
  readonly request: CheckoutRequest;
  readonly host: string;
  readonly layout: Pick<WorkspaceLayout, "worktree">;
  readonly ops: Pick<WorkspaceOps<E>, "checkout">;
}

/**
 * Why a checkout's release leaves it on disk: for a restart to reattach its parent task, or until
 * the parent task is confirmed stopped.
 */
type KeptFor = "reattach" | "unconfirmed-stop";

/** Returns the `CleanupStep` that logs a failed step with the Attempt's fields. */
const cleanupFor =
  <E>(options: Pick<ReleaseOptions<E>, "request" | "host" | "layout">): CleanupStep<E> =>
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
 * Registers the checkout's finalizer. On a non-success exit, salvages a checked-out worktree
 * before removing it; a worktree with unpreserved work stays on disk. `checkedOut` contains the
 * base commit once a worktree exists.
 */
const registerRelease = Effect.fn("Executor.registerRelease")(function* <E extends Error>(
  options: ReleaseOptions<E>,
) {
  const { layout, ops, request } = options;
  const checkedOut = yield* Ref.make(Option.none<CommitSha>());
  const salvaged = yield* Deferred.make<Option.Option<AttemptSalvage>, AttemptFailure>();
  const recorder = yield* Ref.make(Option.none<AttemptChannel.Sink["salvage"]>());
  const cleanup = cleanupFor(options);
  const kept = yield* Ref.make(Option.none<KeptFor>());
  // `kept` is checked even after a successful launch: a failed result write keeps the checkout.
  yield* Effect.addFinalizer(
    Effect.fn("Executor.releaseWorktree")(function* (exit) {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
        host: options.host,
      });
      const keptFor = yield* Ref.get(kept);
      if (Option.isSome(keptFor)) {
        yield* Deferred.succeed(salvaged, Option.none());
        yield* Effect.logInfo(
          keptFor.value === "reattach"
            ? "Leaving the checkout in place for the Attempt's reattachment"
            : "Leaving the checkout in place, without salvage, until the Attempt's parent task is confirmed stopped",
          {
            attemptId: request.attemptId,
            worker: request.worker,
            host: options.host,
            worktree: layout.worktree,
          },
        );
        return;
      }
      const baseCommit = yield* Ref.get(checkedOut);
      const salvage =
        Option.isSome(baseCommit) && !Exit.isSuccess(exit)
          ? request.permissions === "read"
            ? yield* Effect.logInfo(
                "The Attempt's Loop has read permissions, so its checkout is removed without salvage",
                {
                  attemptId: request.attemptId,
                  worker: request.worker,
                  loop: request.loop,
                  host: options.host,
                  worktree: layout.worktree,
                },
              ).pipe(Effect.as(Option.none<AttemptSalvage>()))
            : yield* salvageWorktree({
                attemptId: request.attemptId,
                worker: request.worker,
                host: options.host,
                worktree: layout.worktree,
                baseCommit,
                ref: request.salvageRef,
                git: (args) => ops.checkout.git("cleanup", args),
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
      yield* ops.checkout.remove(cleanup);
    }),
  );
  return {
    checkedOut,
    salvaged: Deferred.await(salvaged),
    recordSalvage: (record: AttemptChannel.Sink["salvage"]) =>
      Ref.set(recorder, Option.some(record)),
    keepForReattach: Ref.set(kept, Option.some<KeptFor>("reattach")),
    keepUntilStopped: Ref.set(kept, Option.some<KeptFor>("unconfirmed-stop")),
  };
});

/**
 * For a `permissions: read` Loop, writes `prePushHook` to a hooks directory inside the
 * checkout's git directory and returns the directory. Returns `None` for `write`.
 */
const installPrePushHook = Effect.fn("Executor.installPrePushHook")(function* <E>(options: {
  readonly request: CheckoutRequest;
  readonly host: string;
  readonly layout: Pick<WorkspaceLayout, "worktree">;
  readonly ops: Pick<WorkspaceOps<E>, "checkout">;
}) {
  const { layout, ops, request } = options;
  const fields = {
    attemptId: request.attemptId,
    worker: request.worker,
    loop: request.loop,
    permissions: request.permissions,
    host: options.host,
  };
  yield* Effect.annotateCurrentSpan(fields);
  if (request.permissions === "write") {
    yield* Effect.logDebug(
      "The Attempt's Loop may push; its checkout keeps git's own hooks",
      fields,
    );
    return Option.none<string>();
  }
  const gitDirectory = (yield* ops.checkout.git("prepare", [
    "-C",
    layout.worktree,
    "rev-parse",
    "--absolute-git-dir",
  ])).trim();
  const hooks = `${gitDirectory}/${PRE_PUSH_HOOKS_DIRECTORY}`;
  yield* ops.checkout.writeExecutable(`${hooks}/pre-push`, prePushHook(request.loop));
  yield* Effect.logInfo(
    "The Attempt's Loop has read permissions; its checkout's pre-push hook explains a refused push",
    { ...fields, hooks },
  );
  return Option.some(hooks);
});

interface SalvageCheckout {
  /** The salvage applied on top of the base commit. */
  readonly resume: Option.Option<SalvagePushed>;
  /** The salvage that conflicts with the base commit and wasn't applied. */
  readonly conflicting: Option.Option<SalvagePushed>;
}

const withoutSalvage: SalvageCheckout = { resume: Option.none(), conflicting: Option.none() };

/**
 * Creates the Attempt's detached worktree at `base`, with the previous Attempt's salvage rebased
 * on top if the request resumes one (#282). A salvage with no changes beyond `base` is dropped;
 * one that doesn't rebase cleanly isn't applied.
 */
const checkOutWorktree = Effect.fn("Executor.checkOutWorktree")(function* <E extends Error>(
  options: ProvisionOptions<E>,
  base: CommitSha,
  salvage: Option.Option<SalvagePushed>,
) {
  const { layout, ops, request } = options;
  const inCache = (args: ReadonlyArray<string>) =>
    ops.git("prepare", ["--git-dir", layout.cache, ...args]);
  const add = ops.checkout.add;
  if (Option.isNone(salvage)) {
    yield* add(base);
    return withoutSalvage;
  }
  const { ref, commit } = salvage.value;
  const fields = {
    attemptId: request.attemptId,
    worker: request.worker,
    host: options.host,
    ref,
    commit,
    base,
  };
  const setAside = (reason: string, message: string) =>
    Effect.gen(function* () {
      yield* Effect.logWarning(reason, { ...fields, message });
      yield* add(base);
      return { resume: Option.none(), conflicting: salvage } satisfies SalvageCheckout;
    });
  const forkPoint = yield* inCache(["merge-base", base, commit]).pipe(
    Effect.map((output) => output.trim()),
    Effect.result,
  );
  if (Result.isFailure(forkPoint)) {
    return yield* setAside(
      "The previous salvage shares no history with the revision; the Attempt starts from the revision and the salvage stays on its branch",
      failureMessage(forkPoint.failure),
    );
  }
  const changed = (yield* inCache(["diff", "--name-only", forkPoint.success, commit])).trim();
  if (changed === "") {
    yield* Effect.logInfo(
      "The previous salvage holds no changes beyond the revision; the Attempt starts from the revision",
      fields,
    );
    yield* add(base);
    return withoutSalvage;
  }
  yield* add(commit);
  if (forkPoint.success === base) {
    yield* Effect.logInfo("Resuming the Attempt from the previous salvage", fields);
    return { resume: salvage, conflicting: Option.none() } satisfies SalvageCheckout;
  }
  const rebased = yield* ops.checkout
    .git("prepare", [
      "-C",
      layout.worktree,
      "-c",
      "commit.gpgsign=false",
      "rebase",
      "--no-verify",
      "--onto",
      base,
      forkPoint.success,
    ])
    .pipe(Effect.result);
  if (Result.isFailure(rebased)) {
    yield* ops.checkout.discard;
    return yield* setAside(
      "The previous salvage does not rebase onto the revision; the Attempt starts from the revision and the salvage stays on its branch",
      failureMessage(rebased.failure),
    );
  }
  const rebasedHead = (yield* ops.checkout.git("prepare", [
    "-C",
    layout.worktree,
    "rev-parse",
    "HEAD",
  ])).trim();
  if (rebasedHead === base) {
    yield* Effect.logInfo(
      "The revision already holds the previous salvage's changes; the Attempt starts from the revision",
      fields,
    );
    return withoutSalvage;
  }
  yield* Effect.logInfo(
    "Resuming the Attempt from the previous salvage, rebased onto the revision",
    { ...fields, forkPoint: forkPoint.success, rebasedHead },
  );
  return { resume: salvage, conflicting: Option.none() } satisfies SalvageCheckout;
});

/**
 * Clones into a staging directory and promotes it on success, fetches the requested revision,
 * and checks out a detached worktree at the resolved commit, applying the previous Attempt's
 * salvage if the request resumes one. Registers the release finalizer before the first
 * filesystem change.
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
  // Registered first so a failed worktree creation, which can leave a directory and a
  // bare-cache registration, is also cleaned up.
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
    // Removes the staging clone before releasing the lock, including on interruption between
    // clone and promotion.
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
          message: "Git returned an invalid object ID",
          cause,
        }),
    ),
  );
  const salvage = yield* fetchSalvage(options, request.resume);
  const checkout = yield* checkOutWorktree(options, baseCommit, salvage);
  yield* Ref.set(release.checkedOut, Option.some(baseCommit));
  const gitHooks = yield* installPrePushHook(options);
  const preparedAt = yield* DateTime.now;
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
        resume: checkout.resume,
        conflictingSalvage: checkout.conflicting,
        preparedAt: Option.some(preparedAt),
        botLogin: request.botLogin,
      }),
      worktree: WorktreePath.make(layout.worktree),
    }),
    salvaged: release.salvaged,
    recordSalvage: release.recordSalvage,
    keepForReattach: release.keepForReattach,
    keepUntilStopped: release.keepUntilStopped,
    gitHooks,
  } satisfies ProvisionedWorktree;
});

export interface ReattachOptions<E> extends ReleaseOptions<E> {
  /** The RunSpec from the parent's durable request. */
  readonly spec: AttemptChannel.RunSpec;
}

/**
 * Reuses an Attempt's checkout after an orchestrator restart without cloning, fetching, or
 * checking out. The same release as a new checkout salvages and removes it when the Attempt
 * ends.
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
  const gitHooks = yield* installPrePushHook(options);
  return {
    workspace: new AttemptWorkspace({
      worker: request.worker,
      spec,
      worktree: WorktreePath.make(layout.worktree),
    }),
    salvaged: release.salvaged,
    recordSalvage: release.recordSalvage,
    keepForReattach: release.keepForReattach,
    keepUntilStopped: release.keepUntilStopped,
    gitHooks,
  } satisfies ProvisionedWorktree;
});

export interface RecoveryOptions<E> {
  readonly attempt: AttemptRecovery;
  readonly host: string;
  readonly worktree: string;
  /**
   * Runs git in the checkout with the Worker's repository credentials. For an Attempt that is
   * salvaged, it also sets the `commitIdentity` that authors the salvage commit.
   */
  readonly git: (args: ReadonlyArray<string>) => Effect.Effect<string, E>;
  /** Removes the checkout and its registration in the cached clone. */
  readonly removeCheckout: Effect.Effect<void, E>;
}

/**
 * Returns the recovery of an unsuccessful Attempt's checkout that its launch kept while the parent
 * task's stop was unconfirmed.
 */
export const keptCheckoutRecovery = (request: CheckoutRequest): AttemptRecovery => ({
  attemptId: request.attemptId,
  worker: request.worker,
  repository: request.repository,
  ref: request.salvageRef,
  permissions: request.permissions,
  succeeded: false,
  open: false,
});

/**
 * Reconciles a checkout left by an earlier process, or kept while its parent task's stop was
 * unconfirmed: salvages it without a known base, records the result, and removes the worktree
 * only after its work is pushed. Checkouts of succeeded Attempts and of `permissions: read` Loops
 * are removed without salvage.
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
  if (attempt.succeeded || attempt.permissions === "read") {
    yield* options.removeCheckout;
    yield* Effect.logInfo(
      attempt.succeeded
        ? "Released the checkout of a succeeded Attempt"
        : "Released the checkout of an Attempt whose Loop has read permissions, without salvage",
      { ...attempt, host, worktree },
    );
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
  yield* options.removeCheckout;
  yield* Effect.logInfo("Reconciled and released Attempt salvage", { ...attempt, host, worktree });
});

/**
 * Fetches the previous Attempt's salvage ref into the cache. If the ref no longer exists, logs
 * a warning and the Attempt starts from its base revision.
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
                message: "Git returned an invalid salvage object ID",
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
  yield* Effect.logInfo("Fetched the previous Attempt's salvage", { ...fields, commit: fetched });
  return Option.some(new SalvagePushed({ ref: resume.value.ref, commit: fetched }));
});
