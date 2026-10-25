import { CHILD_KILL_SCRIPT, type RemoteShell } from "@usine/agents/child-host";
import { ClaudeLoginLock } from "@usine/agents/runtime";
import type { Harness } from "@usine/core/agent/brain";
import type { AttemptId } from "@usine/core/attempt";
import { type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptRecovery, AttemptSalvage, RecoverySink } from "@usine/core/attempt/salvage";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { type CommitSha, RepositoryName, safeSegment } from "@usine/core/repository";
import type { BotAccount, WorkerName } from "@usine/core/worker";
import {
  type AttemptWindowsRead,
  harvestFacts,
  harvestPostedComments,
} from "@usine/core/step/harvest";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
import { Deferred, Effect, Exit, Option, Schema, Scope, SynchronizedRef } from "effect";
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
  type CheckoutOps,
  keptCheckoutRecovery,
  linkedWorktree,
  type ProvisionedWorktree,
  provisionWorktree,
  reattachWorktree,
  recoverWorktree,
  type WorkspaceOps,
} from "../provision.ts";
import {
  type AttemptIsolation,
  attemptContainerName,
  type ContainerSettings,
  containersFor,
  sharedUser,
} from "./container.ts";
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
 * A script that creates the checkout `$1` as its own repository at commit `$4`: objects come from
 * the cached clone `$2` through an alternate, and missing blobs from the partial-clone remote
 * `$3`. The checkout writes only its own directory, so the cached clone can be read-only.
 */
const STANDALONE_CHECKOUT_SCRIPT = String.raw`
set -e
git init -q "$1"
printf '%s\n' "$2/objects" > "$1/.git/objects/info/alternates"
git -C "$1" config core.repositoryformatversion 1
git -C "$1" config extensions.partialClone origin
git -C "$1" remote add origin "$3"
git -C "$1" config remote.origin.promisor true
git -C "$1" config remote.origin.partialclonefilter blob:none
git -C "$1" checkout -q --detach "$4"
`.trim();

/** A script that removes everything inside the directory `$1` and keeps the directory. */
const EMPTY_DIRECTORY_SCRIPT = 'find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} +';

/** The commands of one Attempt in its checkout, and the shell they run in. */
interface CheckoutHost {
  readonly isolation: AttemptIsolation;
  /** Returns the shell for commands in the checkout, starting the Attempt's container on first use. */
  readonly shell: Effect.Effect<RemoteShell, ExecutorError>;
}

/**
 * Returns the executor for Workers accessed over SSH. Each Attempt's Pi parent is a durable task
 * in this process, and each child runs on the machine as one SSH command with a pid file next
 * to the worktree, or inside the Attempt's container. `worker` provides the machine, preflight,
 * isolation, and repository access.
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
    const containers = containersFor(commands);

    const cachePath = (machine: M, repository: RepositoryName) =>
      `${machine.workerDirectory}/repos/${cacheDirectoryName(repository)}`;

    const stopChildren = Effect.fn(span("stopChildren"))(function* (
      operation: ExecutorOperation,
      machine: M,
      worktree: string,
      attemptId: AttemptId,
      isolation: AttemptIsolation,
    ) {
      const host = machine.shell.destination;
      yield* Effect.annotateCurrentSpan({ host, worktree, isolation: isolation._tag });
      if (isolation._tag === "Container")
        return yield* containers.stopChildren(
          operation,
          machine.shell,
          attemptContainerName(attemptId),
          worktree,
        );
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
     * Returns `isolation` for the checkout at `worktree`, or the SSH user's shell if the checkout
     * is a linked worktree from before the machine had a container runtime: its git directory is
     * in the cached clone, which an Attempt container mounts read-only.
     */
    const isolationOfCheckout = Effect.fn(span("isolationOfCheckout"))(function* (
      operation: ExecutorOperation,
      machine: M,
      worktree: string,
      isolation: AttemptIsolation,
    ) {
      if (isolation._tag === "SharedUser") return isolation;
      const linked = yield* commands.inspect(operation, machine.shell, "test", [
        "-f",
        `${worktree}/.git`,
      ]);
      if (linked.exitCode !== 0) return isolation;
      yield* Effect.logWarning(
        "The checkout is a linked worktree from before the Worker ran containers; its commands run as the SSH user",
        { host: machine.shell.destination, worktree },
      );
      return sharedUser;
    });

    /** Returns the container of an Attempt, which mounts its checkout and the paths of `access`. */
    const containerSpec = (
      machine: M,
      settings: ContainerSettings,
      attempt: {
        readonly attemptId: AttemptId;
        readonly worker: WorkerName;
        readonly repository: RepositoryName;
      },
      worktree: string,
      access: RemoteAccess,
      harnesses: ReadonlyArray<Harness>,
    ) => ({
      name: attemptContainerName(attempt.attemptId),
      settings,
      worker: attempt.worker,
      attemptId: Option.some(attempt.attemptId),
      checkout: Option.some({ path: worktree, parent: `${machine.workerDirectory}/attempts` }),
      readOnly: [cachePath(machine, attempt.repository), ...access.readOnlyPaths],
      harnesses,
      environment: access.environment,
      secrets: access.secrets,
    });

    /**
     * Returns where the Attempt's commands in its checkout run. In a container, the container
     * starts on first use in `scope` and is removed when `scope` closes.
     */
    const checkoutHostFor = Effect.fn(span("checkoutHost"))(function* (
      operation: ExecutorOperation,
      scope: Scope.Scope,
      machine: M,
      attempt: Parameters<typeof containerSpec>[2],
      worktree: string,
      access: RemoteAccess,
      isolation: AttemptIsolation,
      harnesses: ReadonlyArray<Harness>,
    ) {
      if (isolation._tag === "SharedUser") {
        const shared: CheckoutHost = { isolation, shell: Effect.succeed(access.shell) };
        return shared;
      }
      const started = yield* SynchronizedRef.make(Option.none<RemoteShell>());
      const spec = containerSpec(machine, isolation.settings, attempt, worktree, access, harnesses);
      const shell = SynchronizedRef.modifyEffect(started, (current) =>
        Option.match(current, {
          onSome: (shell) => Effect.succeed([shell, current] as const),
          onNone: () =>
            containers.start(operation, machine.shell, spec).pipe(
              Scope.provide(scope),
              Effect.map((shell) => [shell, Option.some(shell)] as const),
            ),
        }),
      );
      const contained: CheckoutHost = { isolation, shell };
      return contained;
    });

    /**
     * Runs git on the machine with the Attempt's repository access and `author` as the author and
     * committer, refreshing the credential first if it's about to expire.
     */
    const accessGit =
      (
        operation: ExecutorOperation,
        access: RemoteAccess,
        author: BotAccount,
        shell: Effect.Effect<RemoteShell, ExecutorError> = Effect.succeed(access.shell),
      ) =>
      (args: ReadonlyArray<string>) => {
        const environment = { ...access.gitEnvironment, ...commitIdentity(author) };
        return access.refresh.pipe(
          Effect.andThen(shell),
          Effect.flatMap((on) =>
            commands.run(operation, on, "git", args, { environment, scrub: access.scrub }),
          ),
        );
      };

    const harvestCommand =
      (operation: ExecutorOperation, worktree: string, access: RemoteAccess, shell: RemoteShell) =>
      (command: "git" | "gh", args: ReadonlyArray<string>) =>
        access.refresh
          .pipe(
            Effect.andThen(
              commands.run(operation, shell, command, args, {
                cwd: worktree,
                environment: access.environment,
                scrub: access.scrub,
              }),
            ),
          )
          .pipe(
            Effect.map((stdout) => (stdout === "" ? [] : stdout.replace(/\n$/u, "").split("\n"))),
          );

    /** Returns whether the checkout at `worktree` exists on `machine`. */
    const checkoutExists = (machine: M, worktree: string) =>
      Effect.gen(function* () {
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

    /** Removes the checkout at `worktree` from the machine; it holds no registration in the cached clone. */
    const removeStandalone = (operation: "prepare" | "cleanup", machine: M, worktree: string) =>
      Effect.asVoid(commands.run(operation, machine.shell, "rm", ["-rf", worktree]));

    /**
     * Stops the children in `attempt`'s checkout at `worktree`, salvages it with a new
     * credential, records the salvage through `record`, and removes the checkout once its work is
     * pushed. See `recoverWorktree`.
     */
    const reconcileCheckout = Effect.fn(span("reconcileCheckout"))(function* <E, A>(
      attempt: AttemptRecovery,
      machine: M,
      worktree: string,
      record: RecoverySink<E>["salvage"],
      commitAuthor: Effect.Effect<BotAccount, A>,
    ) {
      yield* Effect.annotateCurrentSpan({ attemptId: attempt.attemptId, worker: attempt.worker });
      const isolation = yield* isolationOfCheckout(
        "cleanup",
        machine,
        worktree,
        yield* worker.isolation(machine),
      );
      const reconcile = (
        git: (args: ReadonlyArray<string>) => Effect.Effect<string, ExecutorError>,
        removeCheckout: Effect.Effect<void, ExecutorError>,
      ) =>
        recoverWorktree(
          { attempt, host: machine.shell.destination, worktree, git, removeCheckout },
          record,
        );
      const removeCheckout = (
        git: (args: ReadonlyArray<string>) => Effect.Effect<string, ExecutorError>,
      ) =>
        isolation._tag === "Container"
          ? removeStandalone("cleanup", machine, worktree)
          : Effect.asVoid(
              git([
                "--git-dir",
                cachePath(machine, attempt.repository),
                "worktree",
                "remove",
                "--force",
                worktree,
              ]),
            );
      if (attempt.succeeded || attempt.permissions === "read") {
        yield* stopChildren("cleanup", machine, worktree, attempt.attemptId, isolation);
        const git = (args: ReadonlyArray<string>) =>
          commands.run("cleanup", machine.shell, "git", args);
        yield* reconcile(git, removeCheckout(git));
        if (isolation._tag === "Container")
          yield* containers.remove(machine.shell, attemptContainerName(attempt.attemptId));
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
          yield* stopChildren("cleanup", machine, worktree, attempt.attemptId, isolation);
          const checkout = yield* checkoutHostFor(
            "cleanup",
            yield* Effect.scope,
            machine,
            attempt,
            worktree,
            access,
            isolation,
            [],
          );
          const git = accessGit("cleanup", access, author, checkout.shell);
          yield* reconcile(git, removeCheckout(git));
        }),
      );
    });

    const recover = Effect.fn(span("recover"))(function* <E, A>(
      attempt: AttemptRecovery,
      record: RecoverySink<E>,
      commitAuthor: Effect.Effect<BotAccount, A>,
    ) {
      yield* Effect.annotateCurrentSpan({ ...attempt });
      yield* session.stopForRecovery(attempt);
      const { machine, checkouts } = yield* workerLeftovers(attempt.worker);
      const worktree = `${machine.workerDirectory}/attempts/${safeSegment(attempt.attemptId)}`;
      // Checks the cached listing first to avoid an SSH round trip per persisted Attempt.
      const present = checkouts.has(worktree) && (yield* checkoutExists(machine, worktree));
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
                  const checkout = yield* checkoutHostFor(
                    "cleanup",
                    yield* Effect.scope,
                    machine,
                    attempt,
                    worktree,
                    access,
                    yield* isolationOfCheckout(
                      "cleanup",
                      machine,
                      worktree,
                      yield* worker.isolation(machine),
                    ),
                    [],
                  );
                  return yield* harvestPostedComments(
                    spec,
                    harvestCommand("cleanup", worktree, access, yield* checkout.shell),
                    windows,
                  );
                }),
              ),
            )
          : Option.none(),
        record,
      );
      if (!present) return;
      yield* reconcileCheckout(attempt, machine, worktree, record.salvage, commitAuthor);
    });

    /**
     * Reconciles the checkout at `worktree` on `machine` that the launch of `request` kept while
     * its parent task's stop was unconfirmed. Does nothing if the checkout is gone.
     */
    const reconcileKept = Effect.fn(span("reconcileKept"))(function* (
      request: CheckoutRequest,
      machine: M,
      worktree: string,
      record: AttemptChannel.Sink["salvage"],
    ) {
      const fields = { attemptId: request.attemptId, worker: request.worker, worktree };
      yield* Effect.annotateCurrentSpan(fields);
      if (!(yield* checkoutExists(machine, worktree))) {
        yield* Effect.logInfo("The kept checkout is gone; nothing to reconcile", fields);
        return;
      }
      yield* reconcileCheckout(
        keptCheckoutRecovery(request),
        machine,
        worktree,
        record,
        Effect.succeed(request.commitAuthor),
      );
    });

    const harvest = (
      workspace: AttemptWorkspace,
      access: RemoteAccess,
      shell: RemoteShell,
      windows: AttemptWindowsRead<AttemptFailure>,
    ) =>
      harvestFacts(
        workspace.spec,
        harvestCommand("launch", workspace.worktree, access, shell),
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
     * parent's RunSpec and how the checkout's commands run.
     */
    const takeOver = Effect.fn(span("takeOver"))(function* (
      request: CheckoutRequest,
      machine: M,
      worktree: string,
      isolation: AttemptIsolation,
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
      const checkoutIsolation = yield* isolationOfCheckout("prepare", machine, worktree, isolation);
      yield* stopChildren("prepare", machine, worktree, request.attemptId, checkoutIsolation);
      return { spec, isolation: checkoutIsolation };
    });

    /**
     * Returns the checkout operations of an Attempt in its own container: a standalone repository
     * that borrows the cached clone's objects, with every git command run in the container.
     */
    const containerCheckout = (
      request: CheckoutRequest,
      machine: M,
      access: RemoteAccess,
      worktree: string,
      cache: string,
      url: string,
      checkout: CheckoutHost,
    ): CheckoutOps<ExecutorError> => {
      const inContainer = (
        operation: ExecutorOperation,
        command: string,
        args: ReadonlyArray<string>,
      ) =>
        access.refresh.pipe(
          Effect.andThen(checkout.shell),
          Effect.flatMap((shell) =>
            commands.run(operation, shell, command, args, {
              environment: { ...access.gitEnvironment, ...commitIdentity(request.commitAuthor) },
              scrub: access.scrub,
            }),
          ),
        );
      return {
        add: (commit: CommitSha) =>
          commands
            .run("prepare", machine.shell, "mkdir", ["-p", worktree])
            .pipe(
              Effect.andThen(
                inContainer("prepare", "sh", [
                  "-c",
                  STANDALONE_CHECKOUT_SCRIPT,
                  "sh",
                  worktree,
                  cache,
                  url,
                  commit,
                ]),
              ),
              Effect.asVoid,
            ),
        // The container mounts the directory itself, so only its contents go.
        discard: Effect.asVoid(
          commands.run("prepare", machine.shell, "sh", [
            "-c",
            EMPTY_DIRECTORY_SCRIPT,
            "sh",
            worktree,
          ]),
        ),
        git: (operation, args) => inContainer(operation, "git", args),
        writeExecutable: (target, content) =>
          Effect.asVoid(
            inContainer("prepare", "sh", ["-c", WRITE_EXECUTABLE_SCRIPT, "sh", target, content]),
          ),
        remove: (cleanup) =>
          cleanup("worktree-directory", removeStandalone("cleanup", machine, worktree)),
      };
    };

    /** Returns the `WorkspaceOps` for the machine; git runs with the Attempt's repository access. */
    const workspaceOps = (
      request: CheckoutRequest,
      machine: M,
      access: RemoteAccess,
      layout: { readonly cache: string; readonly staging: string; readonly worktree: string },
      checkout: CheckoutHost,
    ): WorkspaceOps<ExecutorError> => {
      const host = {
        removePath: (operation: "prepare" | "cleanup", target: string) =>
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
        git: (operation: "prepare" | "cleanup", args: ReadonlyArray<string>) =>
          accessGit(operation, access, request.commitAuthor)(args),
      };
      return {
        ...host,
        ensureRoots: Effect.asVoid(
          commands.run("prepare", machine.shell, "mkdir", [
            "-p",
            `${machine.workerDirectory}/repos`,
            `${machine.workerDirectory}/attempts`,
          ]),
        ),
        promoteStaging: Effect.asVoid(
          commands.run("prepare", machine.shell, "mv", [layout.staging, layout.cache]),
        ),
        checkout:
          checkout.isolation._tag === "Container"
            ? containerCheckout(
                request,
                machine,
                access,
                layout.worktree,
                layout.cache,
                worker.repositoryUrl(machine, request.repository),
                checkout,
              )
            : linkedWorktree(host, layout, (target, content) =>
                Effect.asVoid(
                  commands.run("prepare", machine.shell, "sh", [
                    "-c",
                    WRITE_EXECUTABLE_SCRIPT,
                    "sh",
                    target,
                    content,
                  ]),
                ),
              ),
      };
    };

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
      const workerIsolation = yield* worker.isolation(machine);
      const probeBrain = (shell: RemoteShell) =>
        verifyHarnessReadiness(
          request.worker,
          [request.agent.brain],
          worker.harnessProbe(machine, shell),
          logins,
        );
      // An Attempt container doesn't exist yet, so its probe runs once the checkout is prepared.
      if (workerIsolation._tag === "SharedUser") yield* probeBrain(machine.shell);
      const host = machine.shell.destination;
      const cache = cachePath(machine, request.repository);
      const worktree = `${machine.workerDirectory}/attempts/${safeSegment(request.attemptId)}`;
      const staging = `${cache}.cloning`;
      yield* Effect.annotateCurrentSpan({ host, isolation: workerIsolation._tag });
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
          isolation: workerIsolation._tag,
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
        ? Option.some(yield* takeOver(request, machine, worktree, workerIsolation))
        : Option.none();
      const isolation = Option.match(reattached, {
        onNone: () => workerIsolation,
        onSome: (taken) => taken.isolation,
      });
      if (workerIsolation._tag === "Container" && isolation._tag === "SharedUser")
        yield* probeBrain(machine.shell);
      const harness = Option.match(reattached, {
        onNone: () => request.agent.brain.harness,
        onSome: ({ spec }) => spec.agent.brain.harness,
      });

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
          yield* stopChildren(
            "cleanup",
            machine,
            resource.provisioned.workspace.worktree,
            request.attemptId,
            isolation,
          );
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

      const prepareScope = yield* Effect.scope;
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
        // Forked before the checkout's release is registered, so the container is removed after
        // the release salvages the checkout in it.
        const containerScope = yield* Scope.fork(prepareScope);
        const checkoutHost = yield* checkoutHostFor(
          "prepare",
          containerScope,
          machine,
          request,
          worktree,
          access,
          isolation,
          [harness],
        );
        const ops = workspaceOps(
          request,
          machine,
          access,
          { cache, staging, worktree },
          checkoutHost,
        );
        const checkout = Option.match(reattached, {
          onNone: () =>
            provisionWorktree({
              request,
              url: worker.repositoryUrl(machine, request.repository),
              host,
              layout: { cache, staging, worktree },
              ops,
            }),
          onSome: ({ spec }) =>
            reattachWorktree({ request, host, layout: { worktree }, ops, spec }),
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
        return { provisioned, access, checkoutHost };
      });
      const { provisioned, access, checkoutHost } = yield* (
        request.reattach ? acquire : fetches.withLock(request.repository)(acquire)
      ).pipe(
        Effect.mapError((cause) =>
          isExecutorError(cause)
            ? cause
            : executorError(`Can't prepare the ${label} attempt workspace`, cause),
        ),
      );
      if (isolation._tag === "Container") yield* probeBrain(yield* checkoutHost.shell);

      const prepared = provisioned.workspace;
      yield* Effect.logInfo(`${label} Attempt workspace ready`, {
        attemptId: request.attemptId,
        worker: request.worker,
        host,
        repository: request.repository,
        baseCommit: prepared.spec.baseCommit,
        resume: Option.map(prepared.spec.resume, ({ ref }) => ref),
        reattach: request.reattach,
        isolation: isolation._tag,
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
              const shell = yield* checkoutHost.shell.pipe(
                Effect.mapError(
                  (error) =>
                    new InfraFailure({
                      message: `Can't start the attempt's container: ${error.message}`,
                      cause: error,
                    }),
                ),
              );
              yield* workerWatches.watch({
                attemptId: request.attemptId,
                worker: request.worker,
                shell: machine.shell,
                report: (notice) => runtime.notify(request.attemptId, notice),
              });
              return yield* session.launch(prepared, io, {
                host: shell,
                environment: childEnvironment(
                  access.environment,
                  request.commitAuthor,
                  provisioned.gitHooks,
                ),
                gatewayCredential,
                harvest: (windows) => harvest(prepared, access, shell, windows),
                harvestComments: (windows) =>
                  harvestPostedComments(
                    prepared.spec,
                    harvestCommand("launch", prepared.worktree, access, shell),
                    windows,
                  ),
                keepForReattach: provisioned.keepForReattach,
                keepUntilStopped: provisioned.keepUntilStopped,
                reconcileKept: (record) => reconcileKept(request, machine, worktree, record),
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
