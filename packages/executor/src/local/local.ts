import type { BrainSpec } from "@usine/core/agent/brain";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RepositoryName } from "@usine/core/repository";
import { InstanceDirectory } from "@usine/core/instance";
import {
  Effect,
  FileSystem,
  Layer,
  Path,
  type PlatformError,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { allowlistedEnvironment, collectCommand, requireSuccess } from "../child-command.ts";
import {
  CheckoutRequest,
  CredentialProvider,
  Executor,
  ExecutorError,
  ExecutorOperationError,
  logPreflightFailure,
  type AttemptWorkspace,
  type RunHostCommand,
  WorkerCapabilityError,
  type ExecutorOperation,
} from "../executor.ts";
import { verifyHarnesses } from "../harness-preflight.ts";
import { prepareAttempt } from "../prepared-attempt.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import {
  cacheDirectoryName,
  isCacheDirectoryName,
  provisionWorktree,
  safeSegment,
  type WorkspaceOps,
} from "../provision.ts";
import { runHostSessionFor, type RunHostInput } from "../run-host-session.ts";

export type { RunHostCommand } from "../executor.ts";

/** Storage and run-host settings for Attempts executed on the local machine. */
export interface LocalExecutorOptions {
  /** Factory folder under which local Worker caches and Attempt checkouts are stored. */
  readonly instanceDirectory: InstanceDirectory;
  /** How to launch the one-shot run host; the composition root resolves it. */
  readonly runHost: RunHostCommand;
  /** Repository fetch URL override, for example a local mirror; defaults to the GitHub HTTPS clone URL. */
  readonly repositoryUrl?: (repository: RepositoryName) => string;
  /** Grace for delivering a stop request, then for the run host to exit; each wait is bounded separately. Defaults to two seconds. */
  readonly interruptGrace?: Parameters<typeof Effect.timeoutOption>[1];
}

const isExecutorError = Schema.is(ExecutorError);

/**
 * The run host inherits only these variables. The App private key and every
 * other orchestrator secret stay out; the single-repo worker token is the only
 * credential it receives (ADR 0011).
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

/** Removes the credential from text before it can reach a persisted error message. */
const scrubbed = (text: string, credential: Redacted.Redacted<string>): string =>
  text.replaceAll(Redacted.value(credential), "[REDACTED]");

const credentialEnvironment = (
  base: Record<string, string>,
  credential: Redacted.Redacted<string>,
) => {
  const token = Redacted.value(credential);
  return {
    ...base,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f",
  } as const;
};

const makeLocalExecutor = (options: LocalExecutorOptions) =>
  Effect.gen(function* () {
    const credentials = yield* CredentialProvider;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fetches = yield* keyedLockFor<RepositoryName>();
    const baseEnvironment = yield* allowlistedEnvironment(HOST_ENVIRONMENT_ALLOWLIST);
    const repositoryUrl =
      options.repositoryUrl ??
      ((repository: RepositoryName): string => `https://github.com/${repository}.git`);
    const runHost = options.runHost;
    const interruptGrace = options.interruptGrace ?? "2 seconds";
    const workersRoot = path.join(options.instanceDirectory, ".usine", "workers");

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

    // Worktrees never outlive their Attempt (ADR 0006). A crashed orchestrator
    // leaves directories and bare-cache registrations behind; the sweep reclaims
    // them at the next layer build, before new Attempts start.
    const sweepAbandonedWorktrees = Effect.fn("LocalExecutor.sweepAbandonedWorktrees")(
      function* () {
        if (!(yield* fileSystem.exists(workersRoot))) return;
        const workers = yield* fileSystem.readDirectory(workersRoot);
        for (const worker of workers) {
          const attemptsRoot = path.join(workersRoot, worker, "attempts");
          if (yield* fileSystem.exists(attemptsRoot)) {
            const leftovers = yield* fileSystem.readDirectory(attemptsRoot);
            for (const leftover of leftovers) {
              const target = path.join(attemptsRoot, leftover);
              yield* Effect.logInfo("Sweeping abandoned Attempt worktree", {
                worker,
                host: "local",
                worktree: target,
              });
              yield* fileSystem.remove(target, { recursive: true, force: true });
            }
          }
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
      const reported = (yield* executeCommand("preflight", runHost.command, [
        ...runHost.args,
        "--protocol-version",
      ])).trim();
      if (reported !== String(AttemptChannel.PROTOCOL_VERSION)) {
        return yield* new WorkerCapabilityError({
          worker,
          capability: "run-host",
          message: `Worker ${worker} has run-host protocol ${reported || "unknown"}; expected ${AttemptChannel.PROTOCOL_VERSION}`,
          cause: new Error("run-host protocol mismatch"),
        });
      }
      yield* verifyHarnesses(worker, brains, runHost, (command, args) =>
        executeCommand("preflight", command, args),
      );
      yield* Effect.logInfo("Worker preflight verified", {
        worker,
        host: "local",
        gitVersion,
        protocolVersion: AttemptChannel.PROTOCOL_VERSION,
      });
    }, logPreflightFailure);

    const prepare = Effect.fn("LocalExecutor.prepare")(function* (request: CheckoutRequest) {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        host: "local",
        repository: request.repository,
      });
      yield* verifyHarnesses(request.worker, [request.agent.brain], runHost, (command, args) =>
        executeCommand("preflight", command, args),
      );
      const credential = yield* Effect.acquireRelease(
        credentials.issue(request.repository, request.attemptId),
        (token) =>
          Effect.sync(() => {
            Redacted.wipeUnsafe(token);
          }),
        { interruptible: true },
      );
      const workerRoot = path.join(workersRoot, request.worker);
      const cache = path.join(workerRoot, "repos", cacheDirectoryName(request.repository));
      const worktree = path.join(workerRoot, "attempts", safeSegment(request.attemptId));
      const environment = credentialEnvironment(baseEnvironment, credential);
      const commandOptions = { env: environment, extendEnv: false } as const;
      yield* Effect.logInfo("Preparing Attempt workspace", {
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
        revision: request.revision,
        cache,
        worktree,
      });

      const remove = (
        _operation: "prepare" | "cleanup",
        target: string,
      ): Effect.Effect<void, PlatformError.PlatformError> =>
        fileSystem.remove(target, { recursive: true, force: true });
      const ops: WorkspaceOps<PlatformError.PlatformError | ExecutorOperationError> = {
        ensureRoots: Effect.andThen(
          fileSystem.makeDirectory(path.dirname(cache), { recursive: true }),
          fileSystem.makeDirectory(path.dirname(worktree), { recursive: true }),
        ),
        removePath: remove,
        cacheExists: fileSystem.exists(cache),
        promoteStaging: fileSystem.rename(`${cache}.cloning`, cache),
        git: (operation, args) =>
          Effect.gen(function* () {
            // Git can echo the ambient token in diagnostics. Scrub before forming
            // an error or passing its stdout to the revision parser.
            const result = yield* collectCommand(spawner, operation, "git", args, commandOptions);
            return yield* requireSuccess(operation, "local", "git", args, {
              ...result,
              stdout: scrubbed(result.stdout, credential),
              stderr: scrubbed(result.stderr, credential),
            });
          }),
      };
      const prepared = yield* fetches
        .withLock(request.repository)(
          provisionWorktree({
            request,
            url: repositoryUrl(request.repository),
            host: "local",
            layout: { cache, staging: `${cache}.cloning`, worktree },
            ops,
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            isExecutorError(error)
              ? error
              : executorError("prepare", "Attempt workspace preparation failed", error),
          ),
        );

      yield* Effect.logInfo("Attempt workspace ready", {
        attemptId: request.attemptId,
        baseCommit: prepared.spec.baseCommit,
        worktree,
      });
      return {
        workspace: prepared,
        launch: (io: AttemptChannel.Sink) =>
          session.launch(prepared, io, (input) => spawn(prepared, credential, input)),
      };
    }, prepareAttempt);

    const spawn = Effect.fn("LocalExecutor.spawnRunHost")(function* (
      prepared: AttemptWorkspace,
      credential: Redacted.Redacted<string>,
      input: RunHostInput,
    ) {
      const attemptId = prepared.spec.attemptId;
      yield* Effect.annotateCurrentSpan({
        attemptId,
        worker: prepared.worker,
        host: "local",
      });
      // A linked worktree's git common dir is the bare cache itself, and Turbo
      // puts its cache next to the common dir, so an unscoped run from the
      // worktree would write `repos/.turbo` beside the bare caches. The Worker
      // cache is shared across that Worker's Attempts and stays out of the
      // directory the startup sweep treats as cache storage.
      const turboCache = path.join(workersRoot, prepared.worker, "turbo");
      yield* Effect.logInfo("Launching the run host", {
        attemptId,
        worker: prepared.worker,
        host: "local",
        command: runHost.command,
        worktree: prepared.worktree,
        turboCache,
      });
      const handle = yield* spawner.spawn(
        ChildProcess.make(runHost.command, runHost.args, {
          cwd: prepared.worktree,
          env: {
            ...credentialEnvironment(baseEnvironment, credential),
            TURBO_CACHE_DIR: turboCache,
          },
          extendEnv: false,
          stdin: { stream: Stream.fromQueue(input), endOnDone: true },
        }),
      );
      return {
        handle,
        host: "local",
        scrub: (text: string): string => scrubbed(text, credential),
      };
    });

    const session = yield* runHostSessionFor({ interruptGrace });

    return Executor.of({
      kind: "local",
      cancel: session.cancel,
      preflight,
      prepare,
    });
  });

/** Runs Attempts in isolated checkouts on the local machine. Requires Node; worker contracts are platform-free. */
export const layer = (
  options: LocalExecutorOptions,
): Layer.Layer<
  Executor,
  never,
  CredentialProvider | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(Executor, makeLocalExecutor(options));
