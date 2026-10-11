import type { AttemptId } from "@usine/core/attempt";
import { type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptRecovery, AttemptSalvage } from "@usine/core/attempt/salvage";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { RepositoryName, safeSegment } from "@usine/core/repository";
import { harvestFacts } from "@usine/core/step/harvest";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Deferred, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { durableSessionFor } from "../durable-session.ts";
import {
  type AttemptWorkspace,
  CheckoutRequest,
  CredentialUnavailableError,
  Executor,
  ExecutorError,
  type ExecutorOperation,
  ExecutorOperationError,
} from "../executor.ts";
import { verifyHarnessReadiness } from "../harness-preflight.ts";
import { preparedAttemptsFor } from "../prepared-attempt.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import {
  cacheDirectoryName,
  type ProvisionedWorktree,
  provisionWorktree,
  reattachWorktree,
  recoverWorktree,
  type WorkspaceOps,
} from "../provision.ts";
import { commandsFor } from "./commands.ts";
import { credentialGrantsFor } from "./grants.ts";
import { workerLeftoversFor } from "./leftovers.ts";
import type { ExeDevExecutorOptions, VmState } from "./model.ts";
import { preflightFor } from "./preflight.ts";
import { CHILD_KILL_SCRIPT } from "./shell.ts";
import { abandonedWorktreeSweepFor } from "./sweep.ts";

const isExecutorError = Schema.is(ExecutorError);

const executorError = (message: string, cause: unknown): ExecutorOperationError =>
  new ExecutorOperationError({ operation: "prepare", message, cause });

/** exe.dev injects the GitHub credential for requests to this host at its edge. */
const EDGE_GITHUB_HOST = "github.int.exe.xyz";

/**
 * What every child and harvesting command exports on the VM. Nothing secret
 * passes through this process: the VM's own environment and exe.dev's edge
 * supply the credential (ADR 0011).
 */
const ATTEMPT_ENVIRONMENT = { GH_HOST: EDGE_GITHUB_HOST } satisfies Record<string, string>;

const makeExeDevExecutor = (options: ExeDevExecutorOptions) =>
  Effect.gen(function* () {
    const commands = yield* commandsFor(options.ssh);
    const runtime = yield* AttemptRuntime;
    const fetches = yield* keyedLockFor<RepositoryName>();
    const integrations = new Map(
      options.githubIntegrations.map(({ name, repository }) => [repository, name]),
    );
    const integrationNames = new Set(options.githubIntegrations.map(({ name }) => name));
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

    const machines = yield* preflightFor(options, commands);
    const credentialGrants = yield* credentialGrantsFor(options, commands);
    const sweepAbandonedWorktrees = yield* abandonedWorktreeSweepFor(commands);
    const workerLeftovers = yield* workerLeftoversFor(commands, machines.vmFor);
    const session = yield* durableSessionFor({ interruptGrace });
    const attempts = yield* preparedAttemptsFor(session.stop, session.intervene);

    const stopChildren = Effect.fn("ExeDevExecutor.stopChildren")(function* (
      operation: ExecutorOperation,
      vm: VmState,
      worktree: string,
    ) {
      yield* Effect.annotateCurrentSpan({ host: vm.sshDest, worktree });
      const outcome = yield* commands.remote(operation, vm.sshDest, "sh", [
        "-c",
        CHILD_KILL_SCRIPT,
        "sh",
        worktree,
      ]);
      yield* Effect.logInfo("Confirmed no child of the Attempt runs on the VM", {
        host: vm.sshDest,
        worktree,
        children: outcome.trim().split("\n"),
      });
    });

    const isLive = Effect.fn("ExeDevExecutor.isLive")(function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const live = yield* runtime.isLive(attemptId);
      yield* Effect.logDebug("Read whether the Attempt's parent task is live", {
        attemptId,
        live,
      });
      return live;
    });

    const recover = Effect.fn("ExeDevExecutor.recover")(function* <E>(
      attempt: AttemptRecovery,
      record: (salvage: AttemptSalvage) => Effect.Effect<void, E>,
    ) {
      yield* Effect.annotateCurrentSpan({ ...attempt });
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
          });
          return;
        }
      } else {
        yield* session.stopTask(attempt.attemptId, "its Attempt is closed");
      }
      const { vm, root, checkouts } = yield* workerLeftovers(attempt.worker);
      const worktree = `${root}/attempts/${safeSegment(attempt.attemptId)}`;
      // Every persisted Attempt is visited, and almost none left a checkout:
      // the Worker's one listing answers those without an SSH round trip.
      if (!checkouts.has(worktree)) return;
      const inspected = yield* commands.remoteRaw("cleanup", vm.sshDest, "test", ["-d", worktree]);
      if (inspected.exitCode === 1) return;
      if (inspected.exitCode !== 0)
        return yield* executorError(
          "Could not inspect recovery checkout",
          new Error(inspected.stderr),
        );
      const reconcile = recoverWorktree(
        {
          attempt,
          host: vm.sshDest,
          worktree,
          cache: `${root}/repos/${cacheDirectoryName(attempt.repository)}`,
          git: (args) => commands.remote("cleanup", vm.sshDest, "git", args),
        },
        record,
      );
      if (attempt.succeeded) {
        yield* stopChildren("cleanup", vm, worktree);
        yield* reconcile;
        return;
      }
      const integration = integrations.get(attempt.repository);
      if (integration === undefined)
        return yield* new CredentialUnavailableError({
          repository: attempt.repository,
          message: "No integration configured for salvage recovery",
          cause: new Error("missing integration"),
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* credentialGrants.acquire(
            attempt.attemptId,
            attempt.worker,
            attempt.repository,
            integration,
          );
          yield* stopChildren("cleanup", vm, worktree);
          yield* reconcile;
        }),
      );
    });

    // Nothing to scrub: this process never holds a secret the commands could
    // echo, because exe.dev injects the credential at its edge. If a credential
    // ever passes through this process, scrub it here.
    const harvest = (workspace: AttemptWorkspace, vm: VmState) =>
      harvestFacts(workspace.spec, (command, args) =>
        commands
          .remote("launch", vm.sshDest, command, args, {
            cwd: workspace.worktree,
            environment: ATTEMPT_ENVIRONMENT,
          })
          .pipe(
            Effect.map((stdout) => (stdout === "" ? [] : stdout.replace(/\n$/u, "").split("\n"))),
          ),
      ).pipe(
        Effect.mapError(
          (error) =>
            new InfraFailure({
              message: `Could not collect the Attempt's commits: ${error.message}`,
              cause: error,
            }),
        ),
      );

    /**
     * Confirms an Attempt reattached after a restart can take over its checkout:
     * its parent task stored this VM and worktree, and the worktree is still
     * there. Children that outlived the restart are stopped, since the parent
     * starts new ones. Returns the RunSpec the parent started with.
     */
    const takeOver = Effect.fn("ExeDevExecutor.takeOver")(function* (
      request: CheckoutRequest,
      vm: VmState,
      worktree: string,
    ) {
      const stored = yield* runtime
        .request(request.attemptId)
        .pipe(
          Effect.mapError((cause) =>
            executorError("Could not read the reattached Attempt's durable request", cause),
          ),
        );
      if (Option.isNone(stored))
        return yield* executorError(
          "The reattached Attempt has no durable request",
          new Error(request.attemptId),
        );
      const { host, cwd, spec } = stored.value;
      if (host._tag !== "RemoteShell" || host.destination !== vm.sshDest || cwd !== worktree)
        return yield* executorError(
          "The reattached Attempt's checkout is not on this Worker's VM",
          new Error(`${host._tag === "RemoteShell" ? host.destination : host._tag}:${cwd}`),
        );
      const inspected = yield* commands.remoteRaw("prepare", vm.sshDest, "test", ["-d", worktree]);
      if (inspected.exitCode === 1)
        return yield* executorError(
          "The checkout of the reattached Attempt is gone",
          new Error(worktree),
        );
      if (inspected.exitCode !== 0)
        return yield* executorError(
          "Could not inspect the reattached Attempt's checkout",
          new Error(inspected.stderr.trim()),
        );
      yield* stopChildren("prepare", vm, worktree);
      return spec;
    });

    const prepare = Effect.fn("ExeDevExecutor.prepare")(function* (request: CheckoutRequest) {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
        reattach: request.reattach,
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
      yield* verifyHarnessReadiness(
        request.worker,
        [request.agent.brain],
        machines.harnessProbe(vm),
      );
      const root = `${vm.home}/.usine/workers/${safeSegment(request.worker)}`;
      const cache = `${root}/repos/${cacheDirectoryName(request.repository)}`;
      const worktree = `${root}/attempts/${safeSegment(request.attemptId)}`;
      const staging = `${cache}.cloning`;
      const remoteUrl = `https://${EDGE_GITHUB_HOST}/${request.repository}.git`;
      yield* Effect.annotateCurrentSpan({ host: vm.sshDest });
      yield* Effect.logInfo(
        request.reattach
          ? "Reattaching the Attempt to its exe.dev checkout"
          : "Preparing exe.dev Attempt workspace",
        {
          attemptId: request.attemptId,
          worker: request.worker,
          host: vm.sshDest,
          repository: request.repository,
          worktree,
        },
      );
      yield* sweepAbandonedWorktrees(request.attemptId, request.worker, vm, root);
      const reattached = request.reattach
        ? Option.some(yield* takeOver(request, vm, worktree))
        : Option.none();

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

      // A checkout retained after a failed remote stop never closes its scope,
      // so its salvage is answered here rather than by the checkout finalizer.
      const salvaged = yield* Deferred.make<Option.Option<AttemptSalvage>, AttemptFailure>();
      const releaseWorkspace = Effect.fn("ExeDevExecutor.releaseWorkspace")(
        function* (
          resource: { readonly provisioned: ProvisionedWorktree; readonly scope: Scope.Closeable },
          exit: Exit.Exit<unknown, unknown>,
        ) {
          yield* Effect.annotateCurrentSpan({
            attemptId: request.attemptId,
            worker: request.worker,
            host: vm.sshDest,
          });
          // The remote children and their checkout form one cleanup dependency:
          // never close the checkout scope unless this stop request succeeds.
          yield* stopChildren("cleanup", vm, resource.provisioned.workspace.worktree);
          yield* Scope.close(resource.scope, exit);
          const salvage = yield* Effect.exit(resource.provisioned.salvaged);
          yield* Deferred.done(salvaged, salvage);
        },
        (effect) =>
          effect.pipe(
            Effect.tapError((error) =>
              Effect.logError("Remote termination failed; Attempt checkout retained for recovery", {
                attemptId: request.attemptId,
                worker: request.worker,
                host: vm.sshDest,
                worktree,
                message: error.message,
              }),
            ),
            Effect.ignore,
            Effect.andThen(Deferred.succeed(salvaged, Option.none())),
          ),
      );

      const checkout = Option.match(reattached, {
        onNone: () =>
          provisionWorktree({
            request,
            url: remoteUrl,
            host: vm.sshDest,
            layout: { cache, staging, worktree },
            ops,
          }),
        onSome: (spec) =>
          reattachWorktree({ request, host: vm.sshDest, layout: { cache, worktree }, ops, spec }),
      });
      const acquire = Effect.gen(function* () {
        // Credentials belong to the Attempt scope independently of the checkout:
        // refusing destructive cleanup must still release this grant exactly once.
        yield* credentialGrants.acquire(
          request.attemptId,
          request.worker,
          request.repository,
          integration,
        );
        return yield* Effect.acquireRelease(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              // Before preparation succeeds no child can exist. Roll back the
              // partial checkout unconditionally; only a completed workspace is
              // transferred to the guarded remote-process release above.
              const provisioned = yield* restore(checkout).pipe(
                Scope.provide(scope),
                Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
              );
              return { provisioned, scope };
            }),
          ),
          releaseWorkspace,
          { interruptible: true },
        );
      });
      const { provisioned } = yield* (
        request.reattach ? acquire : fetches.withLock(request.repository)(acquire)
      ).pipe(
        Effect.mapError((cause) =>
          isExecutorError(cause)
            ? cause
            : executorError("exe.dev workspace preparation failed", cause),
        ),
      );

      const prepared = provisioned.workspace;
      yield* Effect.logInfo("exe.dev Attempt workspace ready", {
        attemptId: request.attemptId,
        worker: request.worker,
        host: vm.sshDest,
        repository: request.repository,
        baseCommit: prepared.spec.baseCommit,
        resume: Option.map(prepared.spec.resume, ({ ref }) => ref),
        reattach: request.reattach,
        worktree,
      });
      return {
        workspace: prepared,
        launch: (io: AttemptChannel.Sink) =>
          session.launch(prepared, io, {
            host: commands.childHost(vm.sshDest),
            environment: ATTEMPT_ENVIRONMENT,
            harvest: harvest(prepared, vm),
            keepForReattach: provisioned.keepForReattach,
          }),
        salvaged: Deferred.await(salvaged),
        recordSalvage: provisioned.recordSalvage,
      };
    }, attempts.prepare);

    // A reattachment that cannot start must not leave its parent task running
    // unobserved; the engine then retries on a fresh Attempt.
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
    const cancel = Effect.fn("ExeDevExecutor.cancel")(function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      yield* attempts.cancel(attemptId);
      yield* session.stopTask(attemptId, "the Attempt was canceled");
    });

    return Executor.of({
      kind: "exe.dev",
      recover,
      cancel,
      intervene: session.intervene,
      isLive,
      preflight: machines.preflight,
      prepare: prepareOrStop,
    });
  });

/**
 * Runs Attempts on exe.dev Workers: each Attempt's Pi parent is a durable task
 * in this process (`AttemptRuntime`), and its children run on the Worker's VM
 * over SSH. An orchestrator restart reattaches a live Attempt to its VM
 * checkout. Requires Node; worker contracts are platform-free.
 */
export const layer = (
  options: ExeDevExecutorOptions,
): Layer.Layer<Executor, never, AttemptRuntime | ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(Executor, makeExeDevExecutor(options));

export {
  CredentialGrantMinutes,
  type ExeDevExecutorOptions,
  GitHubIntegration,
  IntegrationName,
} from "./model.ts";
