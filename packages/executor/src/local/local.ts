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
  logPreflightFailure,
  WorkerCapabilityError,
  type ExecutorOperation,
} from "../executor.ts";
import {
  agentsHarnessProbe,
  type HarnessProbe,
  verifyHarnessReadiness,
} from "../harness-preflight.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import { withGitHooks } from "../pre-push-hook.ts";
import {
  SwapOnDemand,
  verifyLinuxMemory,
  verifyWorkerMemory,
  WorkerMemory,
} from "../memory-preflight.ts";
import {
  cacheDirectoryName,
  isCacheDirectoryName,
  provisionWorktree,
  reattachWorktree,
  recoverWorktree,
  type WorkspaceOps,
} from "../provision.ts";

export type { HarnessProbe } from "../harness-preflight.ts";

/** Storage and session settings for Attempts executed on the local machine. */
export interface LocalExecutorOptions {
  /** Factory folder under which local Worker caches and Attempt checkouts are stored. */
  readonly instanceDirectory: InstanceDirectory;
  /** Repository fetch URL override, for example a local mirror; defaults to the GitHub HTTPS clone URL. */
  readonly repositoryUrl?: (repository: RepositoryName) => string;
  /** Grace for the parent task's cancellation, then for the Attempt to settle; each wait is bounded separately. Defaults to two seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
  /** Probes one rostered brain on this machine; defaults to the `@usine/agents/preflight` checks, which start no prompt. */
  readonly harnessReadiness?: HarnessProbe;
}

const isExecutorError = Schema.is(ExecutorError);

/**
 * Git and gh commands for an Attempt inherit only these variables. The App
 * private key and every other orchestrator secret stay out; the single-repo
 * worker token is the only credential they receive (ADR 0011).
 */
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

    // Git can echo the ambient token in diagnostics. Scrub before forming an
    // error or passing its stdout to the revision parser: the stderr kept in the
    // error's cause is then safe to record on the Attempt and show an operator.
    const credentialedGit =
      (credential: Effect.Success<ReturnType<typeof credentials>>) =>
      (operation: ExecutorOperation, args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          yield* credential.refresh();
          const result = yield* collectCommand(spawner, operation, "git", args, {
            env: credential.environment,
            extendEnv: false,
          });
          return yield* requireSuccess(operation, "local", "git", args, {
            ...result,
            stdout: credential.scrub(result.stdout),
            stderr: credential.scrub(result.stderr),
          });
        });

    // Recovery owns checkout removal. Startup only prunes registrations whose
    // directories are already absent; unknown crash leftovers, and the checkouts
    // of live Attempts awaiting reattachment, stay on disk.
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

    const recover = Effect.fn("LocalExecutor.recover")(function* <E>(
      attempt: AttemptRecovery,
      record: RecoverySink<E>,
    ) {
      yield* Effect.annotateCurrentSpan({ ...attempt, host: "local" });
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
      const cache = path.join(root, "repos", cacheDirectoryName(attempt.repository));
      if (attempt.succeeded || attempt.permissions === "read") {
        return yield* recoverWorktree(
          {
            attempt,
            host: "local",
            worktree,
            cache,
            git: (args) => executeCommand("cleanup", "git", args),
          },
          record.salvage,
        );
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const credential = yield* credentials(
            attempt.repository,
            attempt.attemptId,
            attempt.permissions,
            baseEnvironment,
          );
          const git = credentialedGit(credential);
          yield* recoverWorktree(
            { attempt, host: "local", worktree, cache, git: (args) => git("cleanup", args) },
            record.salvage,
          );
        }),
      );
    });

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
          message: `Worker ${worker} returned an unrecognized git version`,
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
    }, logPreflightFailure);

    // Nothing an Attempt runs inherits this process's environment, which holds
    // the App private key: only the allowlist and the Attempt's credential (ADR 0011).
    const attemptEnvironment = (
      workspace: AttemptWorkspace,
      credential: Effect.Success<ReturnType<typeof credentials>>,
    ) => ({
      ...credential.environment,
      // A linked worktree's git common dir is the bare cache itself, and Turbo
      // puts its cache next to the common dir, so an unscoped run from the
      // worktree would write `repos/.turbo` beside the bare caches. The Worker
      // cache is shared across that Worker's Attempts and stays out of the
      // directory the startup sweep treats as cache storage.
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
              message: `Could not harvest the Attempt's checkout: ${error.message}`,
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
      const ops: WorkspaceOps<PlatformError.PlatformError | ExecutorError> = {
        ensureRoots: Effect.andThen(
          fileSystem.makeDirectory(path.dirname(cache), { recursive: true }),
          fileSystem.makeDirectory(path.dirname(worktree), { recursive: true }),
        ),
        removePath: remove,
        cacheExists: fileSystem.exists(cache),
        promoteStaging: fileSystem.rename(`${cache}.cloning`, cache),
        git: credentialedGit(credential),
        writeExecutable: (target, content) =>
          fileSystem
            .makeDirectory(path.dirname(target), { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFileString(target, content, { mode: 0o755 }))),
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
            "The checkout of the reattached Attempt is gone",
            new Error(worktree),
          );
        const { spec } = yield* session.storedRequest(request.attemptId);
        return yield* reattachWorktree({
          request,
          host: "local",
          layout: { cache, worktree },
          ops,
          spec,
        });
      });
      const prepared = yield* acquire.pipe(
        Effect.mapError((error) =>
          isExecutorError(error)
            ? error
            : executorError("prepare", "Attempt workspace preparation failed", error),
        ),
      );

      yield* Effect.logInfo("Attempt workspace ready", {
        attemptId: request.attemptId,
        baseCommit: prepared.workspace.spec.baseCommit,
        resume: Option.map(prepared.workspace.spec.resume, ({ ref }) => ref),
        reattach: request.reattach,
        worktree,
      });
      const environment = withGitHooks(
        attemptEnvironment(prepared.workspace, credential),
        prepared.gitHooks,
      );
      return {
        workspace: prepared.workspace,
        launch: (io: AttemptChannel.Sink) =>
          session.launch(prepared.workspace, io, {
            host: new LocalProcess(),
            environment,
            // A local Worker has no Gateway: every harness pays with its own login.
            gatewayCredential: Effect.succeedNone,
            harvest: (windows) => harvest(prepared.workspace, credential, environment, windows),
            harvestComments: (windows) =>
              harvestPostedComments(
                prepared.workspace.spec,
                harvestCommand("launch", prepared.workspace.worktree, credential, environment),
                windows,
              ),
            keepForReattach: prepared.keepForReattach,
          }),
        salvaged: prepared.salvaged,
        recordSalvage: prepared.recordSalvage,
      };
    }, session.prepare);

    return Executor.of({
      kind: "local",
      recover: (attempt, record) =>
        recover(attempt, record).pipe(
          Effect.catchTag("PlatformError", (cause) =>
            Effect.fail(executorError("cleanup", "Could not reconcile local salvage", cause)),
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
 * Runs Attempts in isolated checkouts on the local machine, each with its Pi
 * parent as a durable task in this process (`AttemptRuntime`), so an
 * orchestrator restart reattaches a live Attempt instead of failing it.
 * Requires Node; worker contracts are platform-free.
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
