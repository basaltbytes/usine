import { workerLeftoversFor } from "./leftovers.ts";
import { localCredentialsFor } from "./credentials.ts";
import { durableSessionFor } from "./durable-session.ts";
import { agentsHarnessProbe } from "./harness-probe.ts";
import type { AttemptRecovery, AttemptSalvage } from "@usine/core/attempt/salvage";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { InfraFailure } from "@usine/core/attempt/failure";
import { RepositoryName, safeSegment } from "@usine/core/repository";
import { InstanceDirectory } from "@usine/core/instance";
import { harvestFacts } from "@usine/core/step/harvest";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
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
import { allowlistedEnvironment, collectCommand, requireSuccess } from "../child-command.ts";
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
import { type HarnessProbe, verifyHarnessReadiness } from "../harness-preflight.ts";
import { preparedAttemptsFor } from "../prepared-attempt.ts";
import { keyedLockFor } from "../keyed-lock.ts";
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
    const baseEnvironment = yield* allowlistedEnvironment(HOST_ENVIRONMENT_ALLOWLIST);
    const harnessReadiness =
      options.harnessReadiness ?? agentsHarnessProbe(spawner, baseEnvironment);
    const repositoryUrl =
      options.repositoryUrl ??
      ((repository: RepositoryName): string => `https://github.com/${repository}.git`);
    const runtime = yield* AttemptRuntime;
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

    const isLive = Effect.fn("LocalExecutor.isLive")(function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId, host: "local" });
      const live = yield* runtime.isLive(attemptId);
      yield* Effect.logDebug("Read whether the Attempt's parent task is live", {
        attemptId,
        live,
      });
      return live;
    });

    const workerLeftovers = yield* workerLeftoversFor(workersRoot);

    const recover = Effect.fn("LocalExecutor.recover")(function* <E>(
      attempt: AttemptRecovery,
      record: (salvage: AttemptSalvage) => Effect.Effect<void, E>,
    ) {
      yield* Effect.annotateCurrentSpan({ ...attempt, host: "local" });
      if (attempt.open) {
        const live = yield* isLive(attempt.attemptId).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              "Could not read whether an open Attempt's parent task is live; reconciling its checkout",
              { attemptId: attempt.attemptId, worker: attempt.worker, message: error.message },
            ),
          ),
          Effect.orElseSucceed(() => false),
        );
        if (live) {
          yield* Effect.logInfo("Leaving the checkout of a live Attempt for its reattachment", {
            attemptId: attempt.attemptId,
            worker: attempt.worker,
            host: "local",
          });
          return;
        }
      } else {
        yield* session.stopTask(attempt.attemptId, "its Attempt is closed");
      }
      const root = path.join(workersRoot, attempt.worker);
      const worktree = path.join(root, "attempts", safeSegment(attempt.attemptId));
      if (!(yield* workerLeftovers(attempt.worker)).has(worktree)) return;
      if (!(yield* fileSystem.exists(worktree))) return;
      const cache = path.join(root, "repos", cacheDirectoryName(attempt.repository));
      if (attempt.succeeded) {
        return yield* recoverWorktree(
          {
            attempt,
            host: "local",
            worktree,
            cache,
            git: (args) => executeCommand("cleanup", "git", args),
          },
          record,
        );
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const credential = yield* credentials(
            attempt.repository,
            attempt.attemptId,
            baseEnvironment,
          );
          const git = credentialedGit(credential);
          yield* recoverWorktree(
            { attempt, host: "local", worktree, cache, git: (args) => git("cleanup", args) },
            record,
          );
        }),
      );
    });

    const preflight = Effect.fn("LocalExecutor.preflight")(function* (
      worker: CheckoutRequest["worker"],
      brains: ReadonlyArray<BrainSpec>,
    ) {
      yield* Effect.annotateCurrentSpan({ worker, host: "local" });
      const gitVersion = (yield* executeCommand("preflight", "git", ["--version"])).trim();
      if (!gitVersion.startsWith("git version ")) {
        return yield* new WorkerCapabilityError({
          worker,
          capability: "toolchain",
          message: `Worker ${worker} returned an unrecognized git version`,
          cause: new Error(gitVersion),
        });
      }
      yield* verifyHarnessReadiness(worker, brains, harnessReadiness);
      yield* Effect.logInfo("Worker preflight verified", {
        worker,
        host: "local",
        gitVersion,
      });
    }, logPreflightFailure);

    const attempts = yield* preparedAttemptsFor(session.stop, session.intervene);

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
    ) =>
      harvestFacts(workspace.spec, (command, args) =>
        Effect.gen(function* () {
          yield* credential.refresh();
          const result = yield* collectCommand(spawner, "launch", command, args, {
            cwd: workspace.worktree,
            env: environment,
            extendEnv: false,
          });
          const stdout = yield* requireSuccess("launch", "local", command, args, {
            ...result,
            stdout: credential.scrub(result.stdout),
            stderr: credential.scrub(result.stderr),
          });
          return stdout === "" ? [] : stdout.replace(/\n$/u, "").split("\n");
        }),
      ).pipe(
        Effect.mapError(
          (error) =>
            new InfraFailure({
              message: `Could not collect the Attempt's commits: ${error.message}`,
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
        reattach: request.reattach,
      });
      yield* verifyHarnessReadiness(request.worker, [request.agent.brain], harnessReadiness);
      const credential = yield* credentials(request.repository, request.attemptId, baseEnvironment);
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
        const stored = yield* runtime.request(request.attemptId);
        if (Option.isNone(stored))
          return yield* executorError(
            "prepare",
            "The reattached Attempt has no durable request",
            new Error(request.attemptId),
          );
        return yield* reattachWorktree({
          request,
          host: "local",
          layout: { cache, worktree },
          ops,
          spec: stored.value.spec,
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
      const environment = attemptEnvironment(prepared.workspace, credential);
      return {
        workspace: prepared.workspace,
        launch: (io: AttemptChannel.Sink) =>
          session.launch(prepared.workspace, io, {
            environment,
            harvest: harvest(prepared.workspace, credential, environment),
            keepForReattach: prepared.keepForReattach,
          }),
        salvaged: prepared.salvaged,
        recordSalvage: prepared.recordSalvage,
      };
    }, attempts.prepare);

    // A reattachment that cannot start must not leave its parent task running unobserved.
    const prepareOrStop = (request: CheckoutRequest) =>
      prepare(request).pipe(
        Effect.tapError(() =>
          request.reattach
            ? session.stopTask(request.attemptId, "its reattachment could not be prepared")
            : Effect.void,
        ),
      );

    // A canceled Attempt may hold a live parent task this process never
    // launched, such as one still awaiting its reattachment after a restart.
    const cancel = Effect.fn("LocalExecutor.cancel")(function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId, host: "local" });
      yield* attempts.cancel(attemptId);
      yield* session.stopTask(attemptId, "the Attempt was canceled");
    });

    return Executor.of({
      kind: "local",
      recover: (attempt, record) =>
        recover(attempt, record).pipe(
          Effect.catchTag("PlatformError", (cause) =>
            Effect.fail(executorError("cleanup", "Could not reconcile local salvage", cause)),
          ),
        ),
      cancel,
      intervene: session.intervene,
      isLive,
      preflight,
      prepare: prepareOrStop,
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
  | CredentialProvider
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(Executor, makeLocalExecutor(options));
