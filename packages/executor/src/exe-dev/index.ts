import { Attempt, AttemptChannel, Repository } from "@usine/core";
import { Effect, Layer, PartitionedSemaphore, Ref, Result, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  CheckoutRequest,
  CredentialUnavailableError,
  Executor,
  ExecutorError,
  ExecutorOperationError,
  PreparedAttempt,
  WorktreePath,
} from "../index.ts";
import { attemptChannelFor } from "./channel.ts";
import { commandsFor } from "./commands.ts";
import { credentialGrantsFor } from "./grants.ts";
import {
  CredentialGrantMinutes,
  type ExeDevExecutorOptions,
  GitHubIntegration,
  HarnessLoginCheck,
  IntegrationName,
  type PreparedState,
} from "./model.ts";
import { preflightFor } from "./preflight.ts";
import { abandonedWorktreeSweepFor } from "./sweep.ts";

export {
  CredentialGrantMinutes,
  type ExeDevExecutorOptions,
  GitHubIntegration,
  HarnessLoginCheck,
  IntegrationName,
};

const decodeCommit = Schema.decodeUnknownEffect(Repository.CommitSha);
const isExecutorError = Schema.is(ExecutorError);

const safeSegment = (value: string): string => value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

const executorError = (message: string, cause: unknown): ExecutorOperationError =>
  new ExecutorOperationError({ operation: "prepare", message, cause });

const makeExeDevExecutor = (options: ExeDevExecutorOptions) =>
  Effect.gen(function* () {
    const commands = yield* commandsFor(options.ssh);
    const fetches = yield* PartitionedSemaphore.make<string>({ permits: 1 });
    const preparedStates = yield* Ref.make(new Map<Attempt.AttemptId, PreparedState>());
    const integrations = new Map(
      options.githubIntegrations.map(({ name, repository }) => [repository, name]),
    );
    const integrationNames = new Set(options.githubIntegrations.map(({ name }) => name));
    const runHost = options.runHost ?? { command: "usine-run-host", args: [] };
    const interruptGrace = options.interruptGrace ?? "2 seconds";

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

    const worker = yield* preflightFor(options, commands, runHost);
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
      const vm = yield* worker.vmFor(request.worker);
      const root = `${vm.home}/.usine/workers/${safeSegment(request.worker)}`;
      const cache = `${root}/repos/${safeSegment(request.repository)}.git`;
      const worktree = `${root}/attempts/${safeSegment(request.attemptId)}`;
      const staging = `${cache}.cloning`;
      const remoteUrl = `https://github.int.exe.xyz/${request.repository}.git`;
      yield* Effect.annotateCurrentSpan({ host: vm.sshDest });
      yield* sweepAbandonedWorktrees(request.attemptId, request.worker, vm, root);

      yield* credentialGrants.acquire(request.worker, request.repository, integration);
      const prepared = yield* fetches
        .withPermit(request.repository)(
          Effect.gen(function* () {
            yield* commands.remote("prepare", vm, "mkdir", [
              "-p",
              `${root}/repos`,
              `${root}/attempts`,
            ]);
            yield* commands.remote("prepare", vm, "rm", ["-rf", worktree]);
            const cacheExists = yield* commands.remoteRaw("prepare", vm, "test", ["-d", cache]);
            if (cacheExists.exitCode !== 0 && cacheExists.exitCode !== 1) {
              return yield* executorError(
                `Could not inspect the cached clone on Worker ${request.worker}`,
                new Error(cacheExists.stderr.trim()),
              );
            }
            if (cacheExists.exitCode === 1) {
              yield* commands.remote("prepare", vm, "rm", ["-rf", staging]);
              yield* commands
                .remote("prepare", vm, "git", [
                  "clone",
                  "--bare",
                  "--filter=blob:none",
                  remoteUrl,
                  staging,
                ])
                .pipe(
                  Effect.onError(() =>
                    commands.remote("prepare", vm, "rm", ["-rf", staging]).pipe(
                      Effect.tapError((error) =>
                        Effect.logWarning("Could not remove a partial exe.dev clone", {
                          attemptId: request.attemptId,
                          worker: request.worker,
                          host: vm.sshDest,
                          message: error.message,
                        }),
                      ),
                      Effect.ignore,
                    ),
                  ),
                );
              yield* commands.remote("prepare", vm, "mv", [staging, cache]);
            } else {
              yield* commands.remote("prepare", vm, "git", [
                "--git-dir",
                cache,
                "remote",
                "set-url",
                "origin",
                remoteUrl,
              ]);
            }
            yield* commands.remote("prepare", vm, "git", [
              "--git-dir",
              cache,
              "fetch",
              "--force",
              "--prune",
              "origin",
              request.revision,
            ]);
            const resolved = (yield* commands.remote("prepare", vm, "git", [
              "--git-dir",
              cache,
              "rev-parse",
              "FETCH_HEAD",
            ])).trim();
            const baseCommit = yield* decodeCommit(resolved).pipe(
              Effect.mapError((cause) =>
                executorError("Remote Git returned an invalid object id", cause),
              ),
            );
            yield* commands.remote("prepare", vm, "git", [
              "--git-dir",
              cache,
              "worktree",
              "add",
              "--detach",
              worktree,
              baseCommit,
            ]);
            const prepared = new PreparedAttempt({
              worker: request.worker,
              spec: new AttemptChannel.RunSpec({
                attemptId: request.attemptId,
                repository: request.repository,
                revision: request.revision,
                baseCommit,
                task: request.task,
              }),
              worktree: WorktreePath.make(worktree),
            });
            yield* Ref.update(preparedStates, (current) => {
              const next = new Map(current);
              next.set(request.attemptId, { cache, integration, vm });
              return next;
            });
            return prepared;
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
              yield* commands.remote("cleanup", vm, "rm", ["-rf", worktree, staging]).pipe(
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
      const removed = yield* commands.remoteRaw("cleanup", state.vm, "git", [
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
      yield* commands.remote("cleanup", state.vm, "rm", ["-rf", prepared.worktree]);
      yield* commands.remote("cleanup", state.vm, "git", [
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
      const [worktreeResult, grantResult] = yield* Effect.all([
        cleanWorktree(prepared, state).pipe(Effect.result),
        credentialGrants.release(prepared.worker, state.integration).pipe(Effect.result),
      ]);
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
      yield* Ref.update(preparedStates, (current) => {
        const next = new Map(current);
        next.delete(attemptId);
        return next;
      });
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
      preflight: worker.preflight,
      prepare,
    });
  });

/** Node-only exe.dev adapter; the package root remains platform-free. */
export const layer = (
  options: ExeDevExecutorOptions,
): Layer.Layer<Executor, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(Executor, makeExeDevExecutor(options));
