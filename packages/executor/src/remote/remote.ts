import { CHILD_KILL_SCRIPT } from "@usine/agents/child-host";
import { type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptRecovery, AttemptSalvage } from "@usine/core/attempt/salvage";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { RepositoryName, safeSegment } from "@usine/core/repository";
import { harvestFacts } from "@usine/core/step/harvest";
import { Deferred, Effect, Exit, Option, Schema, Scope } from "effect";
import { durableSessionFor } from "../durable-session.ts";
import {
  type AttemptWorkspace,
  CheckoutRequest,
  Executor,
  ExecutorError,
  type ExecutorOperation,
  ExecutorOperationError,
} from "../executor.ts";
import { verifyHarnessReadiness } from "../harness-preflight.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import {
  cacheDirectoryName,
  type ProvisionedWorktree,
  provisionWorktree,
  reattachWorktree,
  recoverWorktree,
  type WorkspaceOps,
} from "../provision.ts";
import { workerLeftoversFor } from "./leftovers.ts";
import type { RemoteAccess, RemoteMachine, RemoteWorker } from "./machine.ts";
import { abandonedWorktreeSweepFor } from "./sweep.ts";

const isExecutorError = Schema.is(ExecutorError);

const executorError = (message: string, cause: unknown): ExecutorOperationError =>
  new ExecutorOperationError({ operation: "prepare", message, cause });

/**
 * The Executor for a Worker whose machine the orchestrator reaches over SSH:
 * each Attempt's Pi parent is a durable task in this process, and its children
 * run on the machine as one SSH command each, with a pid file beside the
 * worktree. `worker` supplies the machine, its preflight, and the Attempt's
 * repository access; checkouts, salvage, recovery, and reattachment are shared
 * by every remote Worker kind.
 */
export const remoteExecutorFor = <M extends RemoteMachine>(worker: RemoteWorker<M>) =>
  Effect.gen(function* () {
    const { commands, label } = worker;
    const span = (name: string) => `${worker.spanPrefix}.${name}`;
    const fetches = yield* keyedLockFor<RepositoryName>();
    const sweepAbandonedWorktrees = yield* abandonedWorktreeSweepFor(commands);
    const workerLeftovers = yield* workerLeftoversFor(commands, worker.machineFor, worker.reclaim);
    const session = yield* durableSessionFor({ interruptGrace: worker.interruptGrace });

    const stopChildren = Effect.fn(span("stopChildren"))(function* (
      operation: ExecutorOperation,
      machine: M,
      worktree: string,
    ) {
      const host = machine.shell.destination;
      yield* Effect.annotateCurrentSpan({ host, worktree });
      const outcome = yield* commands.run(operation, machine.shell, "sh", [
        "-c",
        CHILD_KILL_SCRIPT,
        "sh",
        worktree,
      ]);
      yield* Effect.logInfo("Confirmed no child of the Attempt runs on the Worker's machine", {
        host,
        worktree,
        children: outcome.trim().split("\n"),
      });
    });

    /** Runs git on the machine with the Attempt's repository access, renewed first when it is about to expire. */
    const accessGit =
      (operation: ExecutorOperation, machine: M, access: RemoteAccess) =>
      (args: ReadonlyArray<string>) =>
        access.refresh.pipe(
          Effect.andThen(
            commands.run(operation, machine.shell, "git", args, {
              environment: access.gitEnvironment,
              scrub: access.scrub,
            }),
          ),
        );

    const recover = Effect.fn(span("recover"))(function* <E>(
      attempt: AttemptRecovery,
      record: (salvage: AttemptSalvage) => Effect.Effect<void, E>,
    ) {
      yield* Effect.annotateCurrentSpan({ ...attempt });
      if (yield* session.awaitsReattach(attempt)) return;
      const { machine, checkouts } = yield* workerLeftovers(attempt.worker);
      const worktree = `${machine.workerDirectory}/attempts/${safeSegment(attempt.attemptId)}`;
      // Every persisted Attempt is visited, and almost none left a checkout:
      // the Worker's one listing answers those without an SSH round trip.
      if (!checkouts.has(worktree)) return;
      const inspected = yield* commands.inspect("cleanup", machine.shell, "test", ["-d", worktree]);
      if (inspected.exitCode === 1) return;
      if (inspected.exitCode !== 0)
        return yield* executorError(
          "Could not inspect recovery checkout",
          new Error(inspected.stderr),
        );
      const reconcile = (
        git: (args: ReadonlyArray<string>) => Effect.Effect<string, ExecutorError>,
      ) =>
        recoverWorktree(
          {
            attempt,
            host: machine.shell.destination,
            worktree,
            cache: `${machine.workerDirectory}/repos/${cacheDirectoryName(attempt.repository)}`,
            git,
          },
          record,
        );
      if (attempt.succeeded) {
        yield* stopChildren("cleanup", machine, worktree);
        yield* reconcile((args) => commands.run("cleanup", machine.shell, "git", args));
        return;
      }
      const grant = yield* worker.grantFor(attempt.repository);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const access = yield* grant.acquire(
            attempt.attemptId,
            attempt.worker,
            machine,
            "cleanup",
          );
          yield* stopChildren("cleanup", machine, worktree);
          yield* reconcile(accessGit("cleanup", machine, access));
        }),
      );
    });

    const harvest = (workspace: AttemptWorkspace, machine: M, access: RemoteAccess) =>
      harvestFacts(workspace.spec, (command, args) =>
        access.refresh
          .pipe(
            Effect.andThen(
              commands.run("launch", machine.shell, command, args, {
                cwd: workspace.worktree,
                environment: access.environment,
                scrub: access.scrub,
              }),
            ),
          )
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
     * its parent task was created for this worktree, and the worktree is still
     * on the machine. Children that outlived the restart are stopped, since the
     * parent starts new ones. Returns the RunSpec the parent started with.
     */
    const takeOver = Effect.fn(span("takeOver"))(function* (
      request: CheckoutRequest,
      machine: M,
      worktree: string,
    ) {
      const { cwd, spec } = yield* session.storedRequest(request.attemptId);
      if (cwd !== worktree)
        return yield* executorError(
          `The reattached Attempt's checkout is not on this ${label} Worker's machine`,
          new Error(cwd),
        );
      const inspected = yield* commands.inspect("prepare", machine.shell, "test", ["-d", worktree]);
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
      yield* stopChildren("prepare", machine, worktree);
      return spec;
    });

    /** The checkout primitives on the machine; git runs with the Attempt's repository access. */
    const workspaceOps = (
      request: CheckoutRequest,
      machine: M,
      access: RemoteAccess,
      layout: { readonly cache: string; readonly staging: string },
    ): WorkspaceOps<ExecutorError> => ({
      ensureRoots: Effect.asVoid(
        commands.run("prepare", machine.shell, "mkdir", [
          "-p",
          `${machine.workerDirectory}/repos`,
          `${machine.workerDirectory}/attempts`,
        ]),
      ),
      removePath: (operation, target) =>
        Effect.asVoid(commands.run(operation, machine.shell, "rm", ["-rf", target])),
      cacheExists: Effect.gen(function* () {
        const inspected = yield* commands.inspect("prepare", machine.shell, "test", [
          "-d",
          layout.cache,
        ]);
        if (inspected.exitCode === 0) return true;
        if (inspected.exitCode === 1) return false;
        return yield* executorError(
          `Could not inspect the cached clone on Worker ${request.worker}`,
          new Error(inspected.stderr.trim()),
        );
      }),
      promoteStaging: Effect.asVoid(
        commands.run("prepare", machine.shell, "mv", [layout.staging, layout.cache]),
      ),
      git: (operation, args) => accessGit(operation, machine, access)(args),
    });

    const prepare = Effect.fn(span("prepare"))(function* (request: CheckoutRequest) {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
        reattach: request.reattach,
      });
      const grant = yield* worker.grantFor(request.repository);
      const machine = yield* worker.machineFor(request.worker);
      yield* verifyHarnessReadiness(
        request.worker,
        [request.agent.brain],
        worker.harnessProbe(machine),
      );
      const host = machine.shell.destination;
      const cache = `${machine.workerDirectory}/repos/${cacheDirectoryName(request.repository)}`;
      const worktree = `${machine.workerDirectory}/attempts/${safeSegment(request.attemptId)}`;
      const staging = `${cache}.cloning`;
      yield* Effect.annotateCurrentSpan({ host });
      yield* Effect.logInfo(
        request.reattach
          ? `Reattaching the Attempt to its ${label} checkout`
          : `Preparing ${label} Attempt workspace`,
        {
          attemptId: request.attemptId,
          worker: request.worker,
          host,
          repository: request.repository,
          worktree,
        },
      );
      yield* sweepAbandonedWorktrees(
        request.attemptId,
        request.worker,
        machine.shell,
        machine.workerDirectory,
      );
      // A reattachment takes its checkout over before any credential is granted.
      const reattached = request.reattach
        ? Option.some(yield* takeOver(request, machine, worktree))
        : Option.none();

      // A checkout retained after a failed remote stop never closes its scope,
      // so its salvage is answered here rather than by the checkout finalizer.
      const salvaged = yield* Deferred.make<Option.Option<AttemptSalvage>, AttemptFailure>();
      const releaseWorkspace = Effect.fn(span("releaseWorkspace"))(
        function* (
          resource: { readonly provisioned: ProvisionedWorktree; readonly scope: Scope.Closeable },
          exit: Exit.Exit<unknown, unknown>,
        ) {
          yield* Effect.annotateCurrentSpan({
            attemptId: request.attemptId,
            worker: request.worker,
            host,
          });
          // The remote children and their checkout form one cleanup dependency:
          // never close the checkout scope unless this stop request succeeds.
          yield* stopChildren("cleanup", machine, resource.provisioned.workspace.worktree);
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
                host,
                worktree,
                message: error.message,
              }),
            ),
            Effect.ignore,
            Effect.andThen(Deferred.succeed(salvaged, Option.none())),
          ),
      );

      const acquire = Effect.gen(function* () {
        // Credentials belong to the Attempt scope independently of the checkout:
        // refusing destructive cleanup must still release them exactly once.
        const access = yield* grant.acquire(request.attemptId, request.worker, machine, "prepare");
        const ops = workspaceOps(request, machine, access, { cache, staging });
        const checkout = Option.match(reattached, {
          onNone: () =>
            provisionWorktree({
              request,
              url: worker.repositoryUrl(request.repository),
              host,
              layout: { cache, staging, worktree },
              ops,
            }),
          onSome: (spec) =>
            reattachWorktree({ request, host, layout: { cache, worktree }, ops, spec }),
        });
        const { provisioned } = yield* Effect.acquireRelease(
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
        return { provisioned, access };
      });
      const { provisioned, access } = yield* (
        request.reattach ? acquire : fetches.withLock(request.repository)(acquire)
      ).pipe(
        Effect.mapError((cause) =>
          isExecutorError(cause)
            ? cause
            : executorError(`${label} workspace preparation failed`, cause),
        ),
      );

      const prepared = provisioned.workspace;
      yield* Effect.logInfo(`${label} Attempt workspace ready`, {
        attemptId: request.attemptId,
        worker: request.worker,
        host,
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
            host: machine.shell,
            environment: { ...access.environment },
            harvest: harvest(prepared, machine, access),
            keepForReattach: provisioned.keepForReattach,
          }),
        salvaged: Deferred.await(salvaged),
        recordSalvage: provisioned.recordSalvage,
      };
    }, session.prepare);

    return Executor.of({
      kind: worker.kind,
      recover,
      cancel: session.cancel,
      intervene: session.intervene,
      isLive: session.isLive,
      outcome: session.outcome,
      preflight: worker.preflight,
      prepare,
    });
  });
