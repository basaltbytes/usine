import { workerLeftoversFor } from "./leftovers.ts";
import { localCredentialsFor } from "./credentials.ts";
import { LocalProcess } from "@usine/agents/child-host";
import { ClaudeLoginLock } from "@usine/agents/runtime";
import type { AttemptRecovery, RecoverySink } from "@usine/core/attempt/salvage";
import type { BrainSpec } from "@usine/core/agent/brain";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { RepositoryName, safeSegment } from "@usine/core/repository";
import { InstanceDirectory } from "@usine/core/instance";
import type { BotAccount } from "@usine/core/worker";
import {
  type AttemptWindowsRead,
  harvestFacts,
  harvestPostedComments,
} from "@usine/core/step/harvest";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Result,
  Schema,
} from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { platform, totalmem } from "node:os";
import { allowlistedEnvironment, collectCommand, requireSuccess } from "../child-command.ts";
import { durableSessionFor, type PostedCommentsHarvest } from "../durable-session.ts";
import {
  type AttemptWorkspace,
  CheckoutRequest,
  CredentialProvider,
  Executor,
  ExecutorError,
  ExecutorOperationError,
  fullPreflight,
  logPreflightFailure,
  WorkerCapabilityError,
  type ExecutorOperation,
} from "../executor.ts";
import {
  agentsHarnessProbe,
  type HarnessProbe,
  verifyHarnessReadiness,
} from "../harness-preflight.ts";
import { childEnvironment, commitIdentity } from "../child-environment.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import {
  SwapOnDemand,
  verifyLinuxMemory,
  verifyWorkerMemory,
  WorkerMemory,
} from "../memory-preflight.ts";
import {
  cacheDirectoryName,
  isCacheDirectoryName,
  keptCheckoutRecovery,
  linkedWorktree,
  provisionWorktree,
  reattachWorktree,
  recoverWorktree,
  recoveryFields,
  type WorkspaceOps,
} from "../provision.ts";

export type { HarnessProbe } from "../harness-preflight.ts";

export interface LocalExecutorOptions {
  /** The directory for local Worker caches and Attempt checkouts. */
  readonly instanceDirectory: InstanceDirectory;
  /** Returns the fetch URL for `repository`, for example a local mirror. Defaults to the GitHub HTTPS clone URL. */
  readonly repositoryUrl?: (repository: RepositoryName) => string;
  /** The timeout for the parent task's cancellation, then separately for the Attempt to finish. Defaults to two seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
  /** Defaults to the `@usine/agents/preflight` checks, which send no prompt. */
  readonly harnessReadiness?: HarnessProbe;
}

const isExecutorError = Schema.is(ExecutorError);

/** The only process variables passed to an Attempt's git and gh commands (ADR 0011). */
const HOST_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
] as const;

const executorError = (
  operation: ExecutorOperation,
  message: string,
  cause: unknown,
): ExecutorOperationError => new ExecutorOperationError({ operation, message, cause });

const makeLocalExecutor = (options: LocalExecutorOptions) =>
  Effect.gen(function* () {
    const credentials = yield* localCredentialsFor;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fetches = yield* keyedLockFor<RepositoryName>();
    const logins = yield* ClaudeLoginLock;
    const baseEnvironment = yield* allowlistedEnvironment(HOST_ENVIRONMENT_ALLOWLIST);
    const harnessReadiness =
      options.harnessReadiness ?? agentsHarnessProbe(spawner, new LocalProcess(), baseEnvironment);
    const repositoryUrl =
      options.repositoryUrl ??
      ((repository: RepositoryName): string => `https://github.com/${repository}.git`);
    const interruptGrace = options.interruptGrace ?? "2 seconds";

    const workersRoot = path.join(options.instanceDirectory, ".usine", "workers");
    const session = yield* durableSessionFor({ interruptGrace });

    const executeCommand = Effect.fn("LocalExecutor.executeCommand")(function* (
      operation: ExecutorOperation,
      command: string,
      args: ReadonlyArray<string>,
      commandOptions: ChildProcess.CommandOptions = {},
    ) {
      yield* Effect.annotateCurrentSpan({ host: "local", operation });
      const result = yield* collectCommand(spawner, operation, command, args, {
        env: baseEnvironment,
        extendEnv: false,
        ...commandOptions,
      });
      return yield* requireSuccess(operation, "local", command, args, result);
    });

    const run = Effect.fn("LocalExecutor.run")(function* (
      operation: ExecutorOperation,
      command: string,
      args: ReadonlyArray<string>,
      commandOptions: ChildProcess.CommandOptions = {},
    ) {
      yield* executeCommand(operation, command, args, commandOptions);
    });

    // Git can print the token in diagnostics, so output is scrubbed before it's put in an error or
    // parsed.
    const credentialedGit = (
      credential: Effect.Success<ReturnType<typeof credentials>>,
      author: BotAccount,
    ) => {
      const environment = { ...credential.environment, ...commitIdentity(author) };
      return (operation: ExecutorOperation, args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* credential.refresh();
          const result = yield* collectCommand(spawner, operation, "git", args, {
            env: environment,
            extendEnv: false,
          });
          return yield* requireSuccess(operation, "local", "git", args, {
            ...result,
            stdout: credential.scrub(result.stdout),
            stderr: credential.scrub(result.stderr),
          });
        });
    };

    // Startup only prunes worktree registrations whose directories are gone; recovery removes
    // checkouts. Unknown leftovers and checkouts awaiting reattachment stay on disk.
    const sweepAbandonedWorktrees = Effect.fn("LocalExecutor.sweepAbandonedWorktrees")(
      function* () {
        if (!(yield* fileSystem.exists(workersRoot))) return;
        const workers = yield* fileSystem.readDirectory(workersRoot);
        for (const worker of workers) {
          const reposRoot = path.join(workersRoot, worker, "repos");
          if (yield* fileSystem.exists(reposRoot)) {
            const entries = yield* fileSystem.readDirectory(reposRoot);
            let pruned = 0;
            let skipped = 0;
            let failed = 0;
            for (const entry of entries) {
              if (!isCacheDirectoryName(entry)) {
                yield* Effect.logDebug("Skipping a non-cache entry during the local cache sweep", {
                  worker,
                  host: "local",
                  entry,
                });
                skipped += 1;
                continue;
              }
              const result = yield* run("cleanup", "git", [
                "--git-dir",
                path.join(reposRoot, entry),
                "worktree",
                "prune",
              ]).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Could not prune a bare cache during the sweep", {
                    worker,
                    host: "local",
                    cache: entry,
                    message: error.message,
                  }),
                ),
                Effect.result,
              );
              if (Result.isSuccess(result)) {
                pruned += 1;
              } else {
                failed += 1;
              }
            }
            yield* Effect.logInfo("Local cache sweep completed", {
              worker,
              host: "local",
              pruned,
              skipped,
              failed,
            });
          }
        }
      },
    );
    yield* sweepAbandonedWorktrees().pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Abandoned-worktree sweep failed; continuing", {
          message: String(error),
        }),
      ),
      Effect.ignore,
    );

    const workerLeftovers = yield* workerLeftoversFor(workersRoot);

    const harvestCommand =
      (
        operation: ExecutorOperation,
        worktree: string,
        credential: Effect.Success<ReturnType<typeof credentials>>,
        environment: Record<string, string>,
      ) =>
      (command: "git" | "gh", args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* credential.refresh();
          const result = yield* collectCommand(spawner, operation, command, args, {
            cwd: worktree,
            env: environment,
            extendEnv: false,
          });
          const stdout = yield* requireSuccess(operation, "local", command, args, {
            ...result,
            stdout: credential.scrub(result.stdout),
            stderr: credential.scrub(result.stderr),
          });
          return stdout === "" ? [] : stdout.replace(/\n$/u, "").split("\n");
        });

    const recover = Effect.fn("LocalExecutor.recover")(function* <E, A>(
      attempt: AttemptRecovery,
      record: RecoverySink<E>,
      commitAuthor: Effect.Effect<BotAccount, A>,
    ) {
      yield* Effect.annotateCurrentSpan({ ...recoveryFields(attempt), host: "local" });
      yield* session.stopForRecovery(attempt);
      const root = path.join(workersRoot, attempt.worker);
      const worktree = path.join(root, "attempts", safeSegment(attempt.attemptId));
      const present =
        (yield* workerLeftovers(attempt.worker)).has(worktree) &&
        (yield* fileSystem.exists(worktree));
      yield* session.recoverPostedComments(
        attempt,
        present
          ? Option.some<PostedCommentsHarvest>((spec, windows) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const credential = yield* credentials(
                    attempt.repository,
                    attempt.attemptId,
                    attempt.permissions,
                    baseEnvironment,
                  );
                  return yield* harvestPostedComments(
                    spec,
                    harvestCommand("cleanup", worktree, credential, credential.environment),
                    windows,
                  );
                }),
              ),
            )
          : Option.none(),
        record,
      );
      if (!present) return;
      yield* reconcileCheckout(attempt, worktree, record.salvage, commitAuthor);
    });

    /**
     * Salvages `attempt`'s checkout at `worktree` with a new credential, records the salvage
     * through `record`, and removes the checkout once its work is pushed. See `recoverWorktree`.
     */
    const reconcileCheckout = Effect.fn("LocalExecutor.reconcileCheckout")(function* <E, A>(
      attempt: AttemptRecovery,
      worktree: string,
      record: RecoverySink<E>["salvage"],
      commitAuthor: Effect.Effect<BotAccount, A>,
    ) {
      yield* Effect.annotateCurrentSpan({ attemptId: attempt.attemptId, worker: attempt.worker });
      const cache = path.join(
        workersRoot,
        attempt.worker,
        "repos",
        cacheDirectoryName(attempt.repository),
      );
      const removeCheckout = <G>(git: (args: ReadonlyArray<string>) => Effect.Effect<string, G>) =>
        Effect.asVoid(git(["--git-dir", cache, "worktree", "remove", "--force", worktree]));
      if (attempt.succeeded || attempt.permissions === "read") {
        const git = (args: ReadonlyArray<string>) => executeCommand("cleanup", "git", args);
        return yield* recoverWorktree(
          { attempt, host: "local", worktree, git, removeCheckout: removeCheckout(git) },
          record,
        );
      }
      const author = yield* commitAuthor;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const credential = yield* credentials(
            attempt.repository,
            attempt.attemptId,
            attempt.permissions,
            baseEnvironment,
          );
          const git = credentialedGit(credential, author);
          const inCheckout = (args: ReadonlyArray<string>) => git("cleanup", args);
          yield* recoverWorktree(
            {
              attempt,
              host: "local",
              worktree,
              git: inCheckout,
              removeCheckout: removeCheckout(inCheckout),
            },
            record,
          );
        }),
      );
    });

    /**
     * Reconciles the checkout at `worktree` that the launch of `request` kept while its parent
     * task's stop was unconfirmed. Does nothing if the checkout is gone.
     */
    const reconcileKept = Effect.fn("LocalExecutor.reconcileKept")(
      function* (
        request: CheckoutRequest,
        worktree: string,
        record: AttemptChannel.Sink["salvage"],
      ) {
        yield* Effect.annotateCurrentSpan({ attemptId: request.attemptId, worker: request.worker });
        if (!(yield* fileSystem.exists(worktree))) {
          yield* Effect.logInfo("The kept checkout is gone; nothing to reconcile", {
            attemptId: request.attemptId,
            worker: request.worker,
            worktree,
          });
          return;
        }
        yield* reconcileCheckout(
          keptCheckoutRecovery(request),
          worktree,
          record,
          Effect.succeed(request.commitAuthor),
        );
      },
      (effect) =>
        effect.pipe(
          Effect.catchTag("PlatformError", (cause) =>
            Effect.fail(executorError("cleanup", "Can't reconcile the kept local checkout", cause)),
          ),
        ),
    );

    const preflight = Effect.fn("LocalExecutor.preflight")(function* (
      worker: CheckoutRequest["worker"],
      brains: ReadonlyArray<BrainSpec>,
      maxConcurrentAttempts: number,
    ) {
      yield* Effect.annotateCurrentSpan({ worker, host: "local", maxConcurrentAttempts });
      const gitVersion = (yield* executeCommand("preflight", "git", ["--version"])).trim();
      if (!gitVersion.startsWith("git version ")) {
        return yield* new WorkerCapabilityError({
          worker,
          capability: "toolchain",
          message: `Worker "${worker}" returned an unrecognized Git version`,
          cause: new Error(gitVersion),
        });
      }
      // macOS has no /proc/meminfo and adds swap files as memory runs short.
      yield* platform() === "darwin"
        ? verifyWorkerMemory(
            worker,
            maxConcurrentAttempts,
            new WorkerMemory({ totalBytes: totalmem(), swap: SwapOnDemand.make({}) }),
          )
        : verifyLinuxMemory(
            worker,
            maxConcurrentAttempts,
            executeCommand("preflight", "cat", ["/proc/meminfo"]),
          );
      yield* verifyHarnessReadiness(worker, brains, harnessReadiness, logins);
      yield* Effect.logInfo("Worker preflight verified", {
        worker,
        host: "local",
        gitVersion,
      });
      return fullPreflight;
    }, logPreflightFailure);

    // Attempt commands receive only the allowlist and the Attempt's credential, never this
    // process's environment, which contains the App private key (ADR 0011).
    const attemptEnvironment = (
      workspace: AttemptWorkspace,
      credential: Effect.Success<ReturnType<typeof credentials>>,
    ) => ({
      ...credential.environment,
      // Turbo writes its cache next to the git common dir, which for a linked worktree is the bare
      // cache. One cache per Worker, outside the directory the startup sweep treats as cache storage.
      TURBO_CACHE_DIR: path.join(workersRoot, workspace.worker, "turbo"),
    });

    const harvest = (
      workspace: AttemptWorkspace,
      credential: Effect.Success<ReturnType<typeof credentials>>,
      environment: Record<string, string>,
      windows: AttemptWindowsRead<AttemptFailure>,
    ) =>
      harvestFacts(
        workspace.spec,
        harvestCommand("launch", workspace.worktree, credential, environment),
        windows,
      ).pipe(
        Effect.mapError(
          (error) =>
            new InfraFailure({
              message: `Can't harvest the attempt's checkout: ${error.message}`,
              cause: error,
            }),
        ),
      );

    const prepare = Effect.fn("LocalExecutor.prepare")(function* (request: CheckoutRequest) {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        host: "local",
        repository: request.repository,
        loop: request.loop,
        permissions: request.permissions,
        reattach: request.reattach,
      });
      yield* verifyHarnessReadiness(
        request.worker,
        [request.agent.brain],
        harnessReadiness,
        logins,
      );
      const credential = yield* credentials(
        request.repository,
        request.attemptId,
        request.permissions,
        baseEnvironment,
      );
      const workerRoot = path.join(workersRoot, request.worker);
      const cache = path.join(workerRoot, "repos", cacheDirectoryName(request.repository));
      const worktree = path.join(workerRoot, "attempts", safeSegment(request.attemptId));
      yield* Effect.logInfo(
        request.reattach
          ? "Reattaching the Attempt to its checkout"
          : "Preparing Attempt workspace",
        {
          attemptId: request.attemptId,
          worker: request.worker,
          repository: request.repository,
          revision: request.revision,
          loop: request.loop,
          permissions: request.permissions,
          cache,
          worktree,
        },
      );

      const remove = (
        _operation: "prepare" | "cleanup",
        target: string,
      ): Effect.Effect<void, PlatformError.PlatformError> =>
        fileSystem.remove(target, { recursive: true, force: true });
      const host = {
        removePath: remove,
        cacheExists: fileSystem.exists(cache),
        git: credentialedGit(credential, request.commitAuthor),
      };
      const ops: WorkspaceOps<PlatformError.PlatformError | ExecutorError> = {
        ...host,
        ensureRoots: Effect.andThen(
          fileSystem.makeDirectory(path.dirname(cache), { recursive: true }),
          fileSystem.makeDirectory(path.dirname(worktree), { recursive: true }),
        ),
        promoteStaging: fileSystem.rename(`${cache}.cloning`, cache),
        checkout: linkedWorktree(host, { cache, worktree }, (target, content) =>
          fileSystem
            .makeDirectory(path.dirname(target), { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(target, content, { mode: 0o755 }))),
        ),
      };
      const acquire = Effect.gen(function* () {
        if (!request.reattach)
          return yield* fetches.withLock(request.repository)(
            provisionWorktree({
              request,
              url: repositoryUrl(request.repository),
              host: "local",
              layout: { cache, staging: `${cache}.cloning`, worktree },
              ops,
            }),
          );
        if (!(yield* fileSystem.exists(worktree)))
          return yield* executorError(
            "prepare",
            "The reattached attempt's checkout no longer exists",
            new Error(worktree),
          );
        const { spec } = yield* session.storedRequest(request.attemptId);
        return yield* reattachWorktree({
          request,
          host: "local",
          layout: { worktree },
          ops,
          spec,
        });
      });
      const prepared = yield* acquire.pipe(
        Effect.mapError((error) =>
          isExecutorError(error)
            ? error
            : executorError("prepare", "Can't prepare the attempt workspace", error),
        ),
      );

      yield* Effect.logInfo("Attempt workspace ready", {
        attemptId: request.attemptId,
        baseCommit: prepared.workspace.spec.baseCommit,
        resume: Option.map(prepared.workspace.spec.resume, ({ ref }) => ref),
        reattach: request.reattach,
        worktree,
      });
      const environment = childEnvironment(
        attemptEnvironment(prepared.workspace, credential),
        request.commitAuthor,
        prepared.gitHooks,
      );
      return {
        workspace: prepared.workspace,
        launch: (io: AttemptChannel.Sink) =>
          session.launch(prepared.workspace, io, {
            host: new LocalProcess(),
            environment,
            // Local Workers have no Gateway; every harness uses its own login.
            gatewayCredential: Effect.succeedNone,
            harvest: (windows) => harvest(prepared.workspace, credential, environment, windows),
            harvestComments: (windows) =>
              harvestPostedComments(
                prepared.workspace.spec,
                harvestCommand("launch", prepared.workspace.worktree, credential, environment),
                windows,
              ),
            keepForReattach: prepared.keepForReattach,
            keepUntilStopped: prepared.keepUntilStopped,
            reconcileKept: (record) => reconcileKept(request, worktree, record),
          }),
        salvaged: prepared.salvaged,
        recordSalvage: prepared.recordSalvage,
      };
    }, session.prepare);

    return Executor.of({
      kind: "local",
      recover: (attempt, record, commitAuthor) =>
        recover(attempt, record, commitAuthor).pipe(
          Effect.catchTag("PlatformError", (cause) =>
            Effect.fail(executorError("cleanup", "Can't reconcile the local salvage", cause)),
          ),
        ),
      cancel: session.cancel,
      intervene: session.intervene,
      isLive: session.isLive,
      outcome: session.outcome,
      preflight,
      prepare,
    });
  });

/**
 * The executor for the local machine. Each Attempt runs in its own checkout with its Pi parent
 * as a durable task in this process (`AttemptRuntime`), so a live Attempt reattaches after an
 * orchestrator restart. Requires Node.
 */
export const layer = (
  options: LocalExecutorOptions,
): Layer.Layer<
  Executor,
  never,
  | AttemptRuntime
  | ClaudeLoginLock
  | CredentialProvider
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(Executor, makeLocalExecutor(options));
