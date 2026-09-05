import type * as AttemptChannel from "@usine/core/attempt/channel";
import { RepositoryName } from "@usine/core/repository";
import { Effect, Layer, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  CheckoutRequest,
  CredentialUnavailableError,
  Executor,
  ExecutorError,
  ExecutorOperationError,
} from "../executor.ts";
import { prepareAttempt } from "../prepared-attempt.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import { provisionWorktree, safeSegment, type WorkspaceOps } from "../provision.ts";
import { attemptChannelFor } from "./channel.ts";
import { commandsFor } from "./commands.ts";
import { credentialGrantsFor } from "./grants.ts";
import type { ExeDevExecutorOptions } from "./model.ts";
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
    const integrations = new Map(
      options.githubIntegrations.map(({ name, repository }) => [repository, name]),
    );
    const integrationNames = new Set(options.githubIntegrations.map(({ name }) => name));
    const runHost = options.runHost ?? { command: "usine-run-host", args: [] };
    // The grace covers an SSH round trip plus the agent flushing its final
    // events, not just a local pipe.
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
    const attemptChannel = yield* attemptChannelFor(commands, runHost, interruptGrace);

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

      const remove = (
        operation: "prepare" | "cleanup",
        target: string,
      ): Effect.Effect<void, ExecutorOperationError> =>
        Effect.asVoid(commands.remote(operation, vm.sshDest, "rm", ["-rf", target]));
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
        git: (operation, args) => commands.remote(operation, vm.sshDest, "git", args),
      };

      const prepared = yield* fetches
        .withLock(request.repository)(
          Effect.gen(function* () {
            // Grant ownership starts only after this Attempt acquires the lock.
            yield* credentialGrants.acquire(
              request.attemptId,
              request.worker,
              request.repository,
              integration,
            );
            return yield* provisionWorktree({
              request,
              url: remoteUrl,
              host: vm.sshDest,
              layout: { cache, staging, worktree },
              ops,
            });
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isExecutorError(cause)
              ? cause
              : executorError("exe.dev workspace preparation failed", cause),
          ),
        );

      // This finalizer precedes checkout removal and grant release. An SSH exit
      // only describes the local client; the recorded remote process is a separate
      // obligation even when the channel disappears or launch fails.
      yield* Effect.addFinalizer(
        Effect.fn("ExeDevExecutor.releaseRunHost")(
          function* () {
            yield* Effect.annotateCurrentSpan({
              attemptId: request.attemptId,
              worker: request.worker,
              host: vm.sshDest,
            });
            const confirmed = yield* commands.remote("cleanup", vm.sshDest, "sh", [
              "-c",
              RUN_HOST_KILL_SCRIPT,
              "sh",
              runHostPidFile(prepared.worktree),
            ]);
            yield* Effect.logInfo("Confirmed the remote run host before workspace removal", {
              attemptId: request.attemptId,
              worker: request.worker,
              host: vm.sshDest,
              runHost: confirmed.trim(),
            });
          },
          (effect) =>
            effect.pipe(
              Effect.tapError((error) =>
                Effect.logError("Remote run-host cleanup failed", {
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

      yield* Effect.logInfo("exe.dev Attempt workspace ready", {
        attemptId: request.attemptId,
        worker: request.worker,
        host: vm.sshDest,
        repository: request.repository,
        baseCommit: prepared.spec.baseCommit,
        worktree,
      });
      return {
        workspace: prepared,
        launch: (io: AttemptChannel.Sink) => attemptChannel.launch(prepared, vm, io),
      };
    }, prepareAttempt);

    return Executor.of({
      kind: "exe.dev",
      cancel: attemptChannel.cancel,
      preflight: machines.preflight,
      prepare,
    });
  });

/** Runs Attempts on exe.dev Workers over SSH. Requires Node; worker contracts are platform-free. */
export const layer = (
  options: ExeDevExecutorOptions,
): Layer.Layer<Executor, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(Executor, makeExeDevExecutor(options));

export {
  CredentialGrantMinutes,
  type ExeDevExecutorOptions,
  GitHubIntegration,
  HarnessLoginCheck,
  IntegrationName,
} from "./model.ts";
