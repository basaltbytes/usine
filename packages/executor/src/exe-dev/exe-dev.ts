import { AttemptId, RepositoryName } from "@usine/core/ids";
import { Effect, Layer, Ref, Result, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  CheckoutRequest,
  CredentialUnavailableError,
  Executor,
  ExecutorError,
  ExecutorOperationError,
  PreparedAttempt,
} from "../executor.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import { provisionWorktree, safeSegment, type WorkspaceOps } from "../provision.ts";
import { attemptChannelFor } from "./channel.ts";
import { commandsFor } from "./commands.ts";
import { credentialGrantsFor } from "./grants.ts";
import type { ExeDevExecutorOptions, PreparedState } from "./model.ts";
import { preflightFor } from "./preflight.ts";
import { RUN_HOST_KILL_SCRIPT, runHostPidFile } from "./shell.ts";
import { abandonedWorktreeSweepFor } from "./sweep.ts";

const isExecutorError = Schema.is(ExecutorError);

const executorError = (message: string, cause: unknown): ExecutorOperationError =>
  new ExecutorOperationError({ operation: "prepare", message, cause });

const makeExeDevExecutor = (options: ExeDevExecutorOptions) =>
  Effect.gen(function* () {
    const commands = yield* commandsFor(options.ssh);
    const fetches = yield* keyedLockFor<RepositoryName>();
    const preparedStates = yield* Ref.make(new Map<AttemptId, PreparedState>());
    const integrations = new Map(
      options.githubIntegrations.map(({ name, repository }) => [repository, name]),
    );
    const integrationNames = new Set(options.githubIntegrations.map(({ name }) => name));
    const runHost = options.runHost ?? { command: "usine-run-host", args: [] };
    // The grace covers an SSH round trip plus the agent flushing its final
    // events, not just a local pipe: budget accordingly.
    const interruptGrace = options.interruptGrace ?? "10 seconds";

    if (integrations.size !== options.githubIntegrations.length) {
      return yield* Effect.die(
        new Error("ExeDevExecutorOptions.githubIntegrations contains duplicate repositories"),
      );
    }
    if (integrationNames.size !== options.githubIntegrations.length) {
      return yield* Effect.die(
        new Error("ExeDevExecutorOptions.githubIntegrations contains duplicate integration names"),
      );
    }

    const machines = yield* preflightFor(options, commands, runHost);
    const credentialGrants = yield* credentialGrantsFor(options, commands);
    const sweepAbandonedWorktrees = yield* abandonedWorktreeSweepFor(commands);
    const attemptChannel = yield* attemptChannelFor(
      commands,
      preparedStates,
      runHost,
      interruptGrace,
    );

    const prepare = Effect.fn("ExeDevExecutor.prepare")(function* (request: CheckoutRequest) {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
      });
      const integration = integrations.get(request.repository);
      if (integration === undefined) {
        return yield* new CredentialUnavailableError({
          repository: request.repository,
          message: `No exe.dev GitHub integration is configured for ${request.repository}`,
          cause: new Error("repository integration missing"),
        });
      }
      const vm = yield* machines.vmFor(request.worker);
      const root = `${vm.home}/.usine/workers/${safeSegment(request.worker)}`;
      const cache = `${root}/repos/${safeSegment(request.repository)}.git`;
      const worktree = `${root}/attempts/${safeSegment(request.attemptId)}`;
      const staging = `${cache}.cloning`;
      const remoteUrl = `https://github.int.exe.xyz/${request.repository}.git`;
      yield* Effect.annotateCurrentSpan({ host: vm.sshDest });
      yield* sweepAbandonedWorktrees(request.attemptId, request.worker, vm, root);

      const remove = (target: string): Effect.Effect<void, ExecutorOperationError> =>
        Effect.asVoid(commands.remote("prepare", vm.sshDest, "rm", ["-rf", target]));
      const ops: WorkspaceOps<ExecutorOperationError> = {
        ensureRoots: Effect.asVoid(
          commands.remote("prepare", vm.sshDest, "mkdir", [
            "-p",
            `${root}/repos`,
            `${root}/attempts`,
          ]),
        ),
        removePath: remove,
        cacheExists: Effect.gen(function* () {
          const inspected = yield* commands.remoteRaw("prepare", vm.sshDest, "test", ["-d", cache]);
          if (inspected.exitCode === 0) return true;
          if (inspected.exitCode === 1) return false;
          return yield* executorError(
            `Could not inspect the cached clone on Worker ${request.worker}`,
            new Error(inspected.stderr.trim()),
          );
        }),
        promoteStaging: Effect.asVoid(
          commands.remote("prepare", vm.sshDest, "mv", [staging, cache]),
        ),
        git: (args: ReadonlyArray<string>): Effect.Effect<string, ExecutorOperationError> =>
          commands.remote("prepare", vm.sshDest, "git", args),
      };

      const prepared = yield* fetches
        .withLock(request.repository)(
          Effect.gen(function* () {
            // The grant attaches inside the compensated region: an interrupt
            // parked on the repository lock must not leak an attachment.
            yield* credentialGrants.acquire(request.worker, request.repository, integration);
            const provisioned = yield* provisionWorktree({
              request,
              url: remoteUrl,
              host: vm.sshDest,
              layout: { cache, staging, worktree },
              ops,
            });
            yield* Ref.update(preparedStates, (current) => {
              const next = new Map(current);
              next.set(request.attemptId, { cache, integration, vm });
              return next;
            });
            return provisioned;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isExecutorError(cause)
              ? cause
              : executorError("exe.dev workspace preparation failed", cause),
          ),
          Effect.onError(() =>
            Effect.gen(function* () {
              yield* Ref.update(preparedStates, (current) => {
                const next = new Map(current);
                next.delete(request.attemptId);
                return next;
              });
              yield* commands.remote("cleanup", vm.sshDest, "rm", ["-rf", worktree, staging]).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Could not remove a partial exe.dev workspace", {
                    attemptId: request.attemptId,
                    worker: request.worker,
                    host: vm.sshDest,
                    message: error.message,
                  }),
                ),
                Effect.ignore,
              );
              yield* credentialGrants.release(request.worker, integration).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Could not detach credentials after prepare failed", {
                    attemptId: request.attemptId,
                    worker: request.worker,
                    host: vm.sshDest,
                    message: error.message,
                  }),
                ),
                Effect.ignore,
              );
            }),
          ),
        );

      yield* Effect.logInfo("exe.dev Attempt workspace ready", {
        attemptId: request.attemptId,
        worker: request.worker,
        host: vm.sshDest,
        repository: request.repository,
        baseCommit: prepared.spec.baseCommit,
        worktree,
      });
      return prepared;
    });

    const cleanWorktree = Effect.fn("ExeDevExecutor.cleanWorktree")(function* (
      prepared: PreparedAttempt,
      state: PreparedState,
    ) {
      yield* Effect.annotateCurrentSpan({
        attemptId: prepared.spec.attemptId,
        worker: prepared.worker,
        host: state.vm.sshDest,
      });
      // Killing the local SSH client says nothing about the VM: confirm the
      // recorded run host is dead before destroying the workspace under it.
      const confirmed = yield* commands.remoteRaw("cleanup", state.vm.sshDest, "sh", [
        "-c",
        RUN_HOST_KILL_SCRIPT,
        "sh",
        runHostPidFile(prepared.worktree),
      ]);
      yield* Effect.logInfo("Confirmed the remote run host before workspace removal", {
        attemptId: prepared.spec.attemptId,
        worker: prepared.worker,
        host: state.vm.sshDest,
        runHost: confirmed.stdout.trim() || `exit ${String(confirmed.exitCode)}`,
      });
      const removed = yield* commands.remoteRaw("cleanup", state.vm.sshDest, "git", [
        "--git-dir",
        state.cache,
        "worktree",
        "remove",
        "--force",
        prepared.worktree,
      ]);
      if (removed.exitCode !== 0) {
        yield* Effect.logDebug("Remote Git worktree removal returned non-zero", {
          attemptId: prepared.spec.attemptId,
          worker: prepared.worker,
          host: state.vm.sshDest,
          exitCode: String(removed.exitCode),
        });
      }
      yield* commands.remote("cleanup", state.vm.sshDest, "rm", ["-rf", prepared.worktree]);
      yield* commands.remote("cleanup", state.vm.sshDest, "git", [
        "--git-dir",
        state.cache,
        "worktree",
        "prune",
      ]);
    });

    const cleanup = Effect.fn("ExeDevExecutor.cleanup")(function* (prepared: PreparedAttempt) {
      const attemptId = prepared.spec.attemptId;
      yield* Effect.annotateCurrentSpan({
        attemptId,
        worker: prepared.worker,
      });
      yield* Effect.logInfo("Cleaning exe.dev Attempt workspace", {
        attemptId,
        worker: prepared.worker,
        worktree: prepared.worktree,
      });
      const state = (yield* Ref.get(preparedStates)).get(attemptId);
      if (state === undefined) {
        yield* Effect.logDebug("exe.dev Attempt cleanup was already complete", {
          attemptId,
          worker: prepared.worker,
        });
        return;
      }
      yield* Effect.annotateCurrentSpan({ host: state.vm.sshDest });
      // The state entry drops exactly once whatever the outcome: a failed
      // cleanup must never leave a retry path that releases the grant twice
      // and detaches a running sibling's credentials.
      const [worktreeResult, grantResult] = yield* Effect.all([
        cleanWorktree(prepared, state).pipe(Effect.result),
        credentialGrants.release(prepared.worker, state.integration).pipe(Effect.result),
      ]).pipe(
        Effect.ensuring(
          Ref.update(preparedStates, (current) => {
            const next = new Map(current);
            next.delete(attemptId);
            return next;
          }),
        ),
      );
      const results = [
        ["worktree", worktreeResult],
        ["credential-grant", grantResult],
      ] as const;
      for (const [resource, result] of results) {
        if (Result.isFailure(result)) {
          yield* Effect.logError("exe.dev Attempt cleanup operation failed", {
            attemptId,
            worker: prepared.worker,
            host: state.vm.sshDest,
            resource,
            message: result.failure.message,
          });
        }
      }
      if (Result.isFailure(worktreeResult)) return yield* worktreeResult.failure;
      if (Result.isFailure(grantResult)) return yield* grantResult.failure;
      yield* Effect.logInfo("exe.dev Attempt cleanup completed", {
        attemptId,
        worker: prepared.worker,
        host: state.vm.sshDest,
      });
    });

    return Executor.of({
      kind: "exe.dev",
      cancel: attemptChannel.cancel,
      cleanup,
      launch: attemptChannel.launch,
      preflight: machines.preflight,
      prepare,
    });
  });

/** Node-only exe.dev adapter; the package root remains platform-free. */
export const layer = (
  options: ExeDevExecutorOptions,
): Layer.Layer<Executor, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(Executor, makeExeDevExecutor(options));
