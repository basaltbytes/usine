import { CHILD_KILL_SCRIPT } from "@usine/agents/child-host";
import { ClaudeLoginLock } from "@usine/agents/runtime";
import { type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptRecovery, AttemptSalvage, RecoverySink } from "@usine/core/attempt/salvage";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { RepositoryName, safeSegment } from "@usine/core/repository";
import type { BotAccount } from "@usine/core/worker";
import {
  type AttemptWindowsRead,
  harvestFacts,
  harvestPostedComments,
} from "@usine/core/step/harvest";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Deferred, Effect, Exit, Option, Schema, Scope } from "effect";
import { durableSessionFor, type PostedCommentsHarvest } from "../durable-session.ts";
import {
  type AttemptWorkspace,
  CheckoutRequest,
  Executor,
  ExecutorError,
  type ExecutorOperation,
  ExecutorOperationError,
  WorkerCapabilityError,
} from "../executor.ts";
import { verifyHarnessReadiness } from "../harness-preflight.ts";
import { childEnvironment, commitIdentity } from "../child-environment.ts";
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
import { workerWatchesFor } from "./liveness.ts";
import type { RemoteAccess, RemoteMachine, RemoteWorker } from "./machine.ts";
import { abandonedWorktreeSweepFor } from "./sweep.ts";

const isExecutorError = Schema.is(ExecutorError);

const executorError = (message: string, cause: unknown): ExecutorOperationError =>
  new ExecutorOperationError({ operation: "prepare", message, cause });

/** A script that writes `$2` to the file `$1`, creating its directory, and makes it executable. */
const WRITE_EXECUTABLE_SCRIPT = String.raw`
set -e
mkdir -p "$(dirname "$1")"
printf '%s' "$2" > "$1"
chmod 755 "$1"
`.trim();

/**
 * Returns the executor for Workers accessed over SSH. Each Attempt's Pi parent is a durable task
 * in this process, and each child runs on the machine as one SSH command with a pid file next
 * to the worktree. `worker` provides the machine, preflight, and repository access.
 */
export const remoteExecutorFor = <M extends RemoteMachine>(worker: RemoteWorker<M>) =>
  Effect.gen(function* () {
    const { commands, label } = worker;
    const span = (name: string) => `${worker.spanPrefix}.${name}`;
    const fetches = yield* keyedLockFor<RepositoryName>();
    const logins = yield* ClaudeLoginLock;
    const sweepAbandonedWorktrees = yield* abandonedWorktreeSweepFor(commands);
    const workerLeftovers = yield* workerLeftoversFor(commands, worker.machineFor, worker.reclaim);
    const session = yield* durableSessionFor({ interruptGrace: worker.interruptGrace });
    const runtime = yield* AttemptRuntime;
    const workerWatches = yield* workerWatchesFor(commands);

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

    /**
     * Runs git on the machine with the Attempt's repository access and `author` as the author and
     * committer, refreshing the credential first if it's about to expire.
     */
    const accessGit = (operation: ExecutorOperation, access: RemoteAccess, author: BotAccount) => {
      const environment = { ...access.gitEnvironment, ...commitIdentity(author) };
      return (args: ReadonlyArray<string>) =>
        access.refresh.pipe(
          Effect.andThen(
            commands.run(operation, access.shell, "git", args, {
              environment,
              scrub: access.scrub,
            }),
          ),
        );
    };

    const harvestCommand =
      (operation: ExecutorOperation, worktree: string, access: RemoteAccess) =>
      (command: "git" | "gh", args: ReadonlyArray<string>) =>
        access.refresh
          .pipe(
            Effect.andThen(
              commands.run(operation, access.shell, command, args, {
                cwd: worktree,
                environment: access.environment,
                scrub: access.scrub,
              }),
            ),
          )
          .pipe(
            Effect.map((stdout) => (stdout === "" ? [] : stdout.replace(/\n$/u, "").split("\n"))),
          );

    const recover = Effect.fn(span("recover"))(function* <E, A>(
      attempt: AttemptRecovery,
      record: RecoverySink<E>,
      commitAuthor: Effect.Effect<BotAccount, A>,
    ) {
      yield* Effect.annotateCurrentSpan({ ...attempt });
      yield* session.stopForRecovery(attempt);
      const { machine, checkouts } = yield* workerLeftovers(attempt.worker);
      const worktree = `${machine.workerDirectory}/attempts/${safeSegment(attempt.attemptId)}`;
      const inspectCheckout = Effect.gen(function* () {
        const inspected = yield* commands.inspect("cleanup", machine.shell, "test", [
          "-d",
          worktree,
        ]);
        if (inspected.exitCode === 1) return false;
        if (inspected.exitCode !== 0)
          return yield* executorError(
            "Can't inspect the recovery checkout",
            new Error(inspected.stderr),
          );
        return true;
      });
      // Checks the cached listing first to avoid an SSH round trip per persisted Attempt.
      const present = checkouts.has(worktree) && (yield* inspectCheckout);
      yield* session.recoverPostedComments(
        attempt,
        present
          ? Option.some<PostedCommentsHarvest>((spec, windows) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const grant = yield* worker.grantFor(attempt.repository);
                  const access = yield* grant.acquire(
                    attempt.attemptId,
                    attempt.worker,
                    attempt.permissions,
                    machine,
                    "cleanup",
                  );
                  return yield* harvestPostedComments(
                    spec,
                    harvestCommand("cleanup", worktree, access),
                    windows,
                  );
                }),
              ),
            )
          : Option.none(),
        record,
      );
      if (!present) return;
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
          record.salvage,
        );
      if (attempt.succeeded || attempt.permissions === "read") {
        yield* stopChildren("cleanup", machine, worktree);
        yield* reconcile((args) => commands.run("cleanup", machine.shell, "git", args));
        return;
      }
      const author = yield* commitAuthor;
      const grant = yield* worker.grantFor(attempt.repository);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const access = yield* grant.acquire(
            attempt.attemptId,
            attempt.worker,
            attempt.permissions,
            machine,
            "cleanup",
          );
          yield* stopChildren("cleanup", machine, worktree);
          yield* reconcile(accessGit("cleanup", access, author));
        }),
      );
    });

    const harvest = (
      workspace: AttemptWorkspace,
      access: RemoteAccess,
      windows: AttemptWindowsRead<AttemptFailure>,
    ) =>
      harvestFacts(
        workspace.spec,
        harvestCommand("launch", workspace.worktree, access),
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

    /**
     * Checks that a reattached Attempt's parent task was created for this worktree and the
     * worktree still exists, then stops children left from before the restart. Returns the
     * parent's RunSpec.
     */
    const takeOver = Effect.fn(span("takeOver"))(function* (
      request: CheckoutRequest,
      machine: M,
      worktree: string,
    ) {
      const { cwd, spec } = yield* session.storedRequest(request.attemptId);
      if (cwd !== worktree)
        return yield* executorError(
          `The reattached attempt's checkout isn't on the machine of this ${label} worker`,
          new Error(cwd),
        );
      const inspected = yield* commands.inspect("prepare", machine.shell, "test", ["-d", worktree]);
      if (inspected.exitCode === 1)
        return yield* executorError(
          "The reattached attempt's checkout no longer exists",
          new Error(worktree),
        );
      if (inspected.exitCode !== 0)
        return yield* executorError(
          "Can't inspect the reattached attempt's checkout",
          new Error(inspected.stderr.trim()),
        );
      yield* stopChildren("prepare", machine, worktree);
      return spec;
    });

    /** Returns the `WorkspaceOps` for the machine; git runs with the Attempt's repository access. */
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
          `Can't inspect the cached clone on worker "${request.worker}"`,
          new Error(inspected.stderr.trim()),
        );
      }),
      promoteStaging: Effect.asVoid(
        commands.run("prepare", machine.shell, "mv", [layout.staging, layout.cache]),
      ),
      git: (operation, args) => accessGit(operation, access, request.commitAuthor)(args),
      writeExecutable: (target, content) =>
        Effect.asVoid(
          commands.run("prepare", machine.shell, "sh", [
            "-c",
            WRITE_EXECUTABLE_SCRIPT,
            "sh",
            target,
            content,
          ]),
        ),
    });

    const prepare = Effect.fn(span("prepare"))(function* (request: CheckoutRequest) {
      yield* Effect.annotateCurrentSpan({
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
        loop: request.loop,
        permissions: request.permissions,
        reattach: request.reattach,
      });
      if (request.permissions === "read" && Option.isSome(worker.readOnlyAccessGap)) {
        const message = `${label} worker "${request.worker}" can't run loop "${request.loop}", which has permissions: read. ${worker.readOnlyAccessGap.value}.`;
        yield* Effect.logWarning("Refused an Attempt that needs read-only repository access", {
          attemptId: request.attemptId,
          worker: request.worker,
          loop: request.loop,
          permissions: request.permissions,
          message,
        });
        return yield* new WorkerCapabilityError({
          worker: request.worker,
          capability: "credentials",
          message,
          cause: new Error(worker.readOnlyAccessGap.value),
        });
      }
      const grant = yield* worker.grantFor(request.repository);
      const machine = yield* worker.machineFor(request.worker);
      yield* verifyHarnessReadiness(
        request.worker,
        [request.agent.brain],
        worker.harnessProbe(machine),
        logins,
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
          loop: request.loop,
          permissions: request.permissions,
          worktree,
        },
      );
      yield* sweepAbandonedWorktrees(
        request.attemptId,
        request.worker,
        machine.shell,
        machine.workerDirectory,
      );
      // A reattachment reuses its checkout before any credential is granted.
      const reattached = request.reattach
        ? Option.some(yield* takeOver(request, machine, worktree))
        : Option.none();

      // A checkout kept after a failed remote stop never closes its scope, so its salvage result
      // is completed here instead of by the checkout finalizer.
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
          // Closes the checkout scope only if stopping the remote children succeeds.
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
        // Credentials are scoped to the Attempt, not the checkout, so they are released exactly once
        // even when checkout cleanup is skipped.
        const access = yield* grant.acquire(
          request.attemptId,
          request.worker,
          request.permissions,
          machine,
          "prepare",
        );
        const ops = workspaceOps(request, machine, access, { cache, staging });
        const checkout = Option.match(reattached, {
          onNone: () =>
            provisionWorktree({
              request,
              url: worker.repositoryUrl(machine, request.repository),
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
              // No child can exist before preparation succeeds, so a partial checkout is always rolled
              // back; only a completed workspace uses the guarded release above.
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
            : executorError(`Can't prepare the ${label} attempt workspace`, cause),
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
          Effect.scoped(
            Effect.gen(function* () {
              // Uses the RunSpec's brain, including on reattachment. Each child reads the kind when it
              // starts, so a preflight during the Attempt takes effect.
              const gatewayCredential = worker.gatewayCredential(
                machine,
                prepared.spec.agent.brain.harness,
              );
              yield* workerWatches.watch({
                attemptId: request.attemptId,
                worker: request.worker,
                shell: machine.shell,
                report: (notice) => runtime.notify(request.attemptId, notice),
              });
              return yield* session.launch(prepared, io, {
                host: access.shell,
                environment: childEnvironment(
                  access.environment,
                  request.commitAuthor,
                  provisioned.gitHooks,
                ),
                gatewayCredential,
                harvest: (windows) => harvest(prepared, access, windows),
                harvestComments: (windows) =>
                  harvestPostedComments(
                    prepared.spec,
                    harvestCommand("launch", prepared.worktree, access),
                    windows,
                  ),
                keepForReattach: provisioned.keepForReattach,
              });
            }),
          ),
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
