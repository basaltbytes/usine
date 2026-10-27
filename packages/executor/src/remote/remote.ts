import { CHILD_KILL_SCRIPT, type RemoteShell } from "@usine/agents/child-host";
import { ClaudeLoginLock } from "@usine/agents/runtime";
import type { Harness } from "@usine/core/agent/brain";
import { type AttemptId, ContainerOutOfMemoryKills } from "@usine/core/attempt";
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
import { Deferred, Effect, Exit, Option, Ref, Schema, Scope, SynchronizedRef } from "effect";
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
  recoveryFields,
  type WorkspaceOps,
} from "../provision.ts";
import {
  type AttemptIsolation,
  attemptContainerName,
  containerCheckoutMarker,
  type ContainerSettings,
  containersFor,
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

/** A script that removes the checkout `$1`, then its container marker `$2`. */
const REMOVE_CHECKOUT_SCRIPT = 'rm -rf "$1" && rm -f "$2"';

/** A script that removes everything inside the directory `$1` and keeps the directory. */
const EMPTY_DIRECTORY_SCRIPT = 'find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} +';

/** The commands of one Attempt in its checkout, and the shell they run in. */
interface CheckoutHost {
  readonly isolation: AttemptIsolation;
  /** Returns the shell for commands in the checkout, starting the Attempt's container on first use. */
  readonly shell: Effect.Effect<RemoteShell, ExecutorError>;
  /**
   * Returns the shell for the salvage once the Attempt's commands end. The first call starts the
   * Attempt's container again if it stopped while the Attempt ran.
   */
  readonly salvageShell: Effect.Effect<RemoteShell, ExecutorError>;
  /**
   * Sets where the processes that the kernel killed in the Attempt's container for memory are
   * recorded before the container is removed. Without it, they're not read.
   */
  readonly recordOutOfMemory: (record: AttemptChannel.Sink["outOfMemory"]) => Effect.Effect<void>;
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
    const attemptMachine =
      worker.attemptMachine ??
      ((name: WorkerName, _attemptId: AttemptId) => worker.machineFor(name));
    const leftoversOf = (attempt: AttemptRecovery) =>
      worker.leftovers === undefined
        ? workerLeftovers(attempt.worker).pipe(Effect.map((found) => Option.some(found)))
        : worker.leftovers(attempt, workerLeftovers(attempt.worker));
    const recovered = worker.recovered ?? (() => Effect.void);
    const checkoutHeld = worker.checkoutHeld ?? (() => Effect.void);
    /** Returns `removal` that records the checkout of `attemptId` as gone once it succeeds. */
    const removing = <A, E, R>(attemptId: AttemptId, removal: Effect.Effect<A, E, R>) =>
      Effect.tap(removal, () => checkoutHeld(attemptId, false));

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
     * Returns how commands run in `attemptId`'s existing checkout at `worktree`: in its container
     * if the container marker, which no container can reach, records one, or as the SSH user if
     * it records none. Nothing in the checkout decides, since an Attempt can change it. Fails if
     * the Worker's `isolation` can't run the checkout that way: a container's checkout on a
     * machine without Docker, or a checkout from before Docker, as the SSH user who can now use
     * Docker.
     */
    const isolationOfCheckout = Effect.fn(span("isolationOfCheckout"))(function* (
      operation: ExecutorOperation,
      machine: M,
      attemptId: AttemptId,
      worktree: string,
      isolation: AttemptIsolation,
    ) {
      if (!worker.runsContainers) return isolation;
      const host = machine.shell.destination;
      yield* Effect.annotateCurrentSpan({ host, worktree, isolation: isolation._tag });
      const contained = yield* containers.marked(
        operation,
        machine.shell,
        containerCheckoutMarker(machine.workerDirectory, attemptId),
      );
      if (contained === (isolation._tag === "Container")) return isolation;
      const message = contained
        ? `The checkout ${worktree} was mounted in an attempt container, and the machine no longer has Docker, so usine runs no command in it as the SSH user. Install Docker, or salvage and remove the checkout by hand.`
        : `The checkout ${worktree} is from before the machine had Docker, and the SSH user can use Docker, so usine runs no command in it as that user. Salvage and remove the checkout by hand.`;
      yield* Effect.logError("Refused to run commands in the checkout", {
        attemptId,
        host,
        worktree,
        contained,
        message,
      });
      return yield* new ExecutorOperationError({
        operation,
        message,
        cause: new Error(contained ? "container marker without Docker" : "no container marker"),
      });
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
      writable: access.writablePaths,
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
        const shell = Effect.succeed(access.shell);
        const shared: CheckoutHost = {
          isolation,
          shell,
          salvageShell: shell,
          recordOutOfMemory: () => Effect.void,
        };
        return shared;
      }
      const started = yield* SynchronizedRef.make(Option.none<RemoteShell>());
      const spec = containerSpec(machine, isolation.settings, attempt, worktree, access, harnesses);
      const marker = containerCheckoutMarker(machine.workerDirectory, attempt.attemptId);
      const recorder = yield* Ref.make(Option.none<AttemptChannel.Sink["outOfMemory"]>());
      // A start gives the container a new cgroup, whose count doesn't include the killed init.
      const killedInits = yield* Ref.make(0);
      const recordKills = Effect.gen(function* () {
        const record = yield* Ref.get(recorder);
        if (Option.isNone(record))
          return yield* Effect.logDebug(
            "No launch ran in the container, so its out-of-memory kills aren't read",
            { attemptId: attempt.attemptId, container: spec.name },
          );
        const { container, kills: counted } = yield* containers.outOfMemoryKills(
          "cleanup",
          machine.shell,
          spec,
        );
        const kills = counted + (yield* Ref.get(killedInits));
        if (kills === 0) return;
        yield* record.value(
          new ContainerOutOfMemoryKills({
            container,
            kills,
            memoryMib: spec.settings.limits.memoryMib,
          }),
        );
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            "Could not record the processes the kernel killed in the Attempt's container",
            {
              attemptId: attempt.attemptId,
              worker: attempt.worker,
              host: machine.shell.destination,
              container: spec.name,
              errorTag: error._tag,
              message: String(error),
            },
          ),
        ),
        Effect.ignore,
        Effect.withSpan(span("recordContainerOutOfMemoryKills"), {
          attributes: {
            attemptId: attempt.attemptId,
            worker: attempt.worker,
            container: spec.name,
          },
        }),
      );
      const shell = SynchronizedRef.modifyEffect(started, (current) =>
        Option.match(current, {
          onSome: (shell) => Effect.succeed([shell, current] as const),
          onNone: () =>
            containers.mark(operation, machine.shell, marker).pipe(
              Effect.andThen(containers.start(operation, machine.shell, spec)),
              // Added after the start's removal, so it runs before it.
              Effect.tap(() => Effect.addFinalizer(() => recordKills)),
              Scope.provide(scope),
              Effect.map((shell) => [shell, Option.some(shell)] as const),
            ),
        }),
      );
      // The kernel can kill the container for memory, or an Attempt can signal its init (#575).
      const salvageShell = yield* Effect.cached(
        Effect.tap(shell, () =>
          containers
            .ensureRunning("cleanup", machine.shell, spec)
            .pipe(
              Effect.tap((oomKilled) =>
                oomKilled ? Ref.update(killedInits, (n) => n + 1) : Effect.void,
              ),
            ),
        ),
      );
      const contained: CheckoutHost = {
        isolation,
        shell,
        salvageShell,
        recordOutOfMemory: (record) => Ref.set(recorder, Option.some(record)),
      };
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

    /**
     * Removes a container's checkout at `worktree` from the machine, then its container marker.
     * It holds no registration in the cached clone.
     */
    const removeStandalone = (
      operation: "prepare" | "cleanup",
      machine: M,
      attemptId: AttemptId,
      worktree: string,
    ) =>
      Effect.asVoid(
        commands.run(operation, machine.shell, "sh", [
          "-c",
          REMOVE_CHECKOUT_SCRIPT,
          "sh",
          worktree,
          containerCheckoutMarker(machine.workerDirectory, attemptId),
        ]),
      );

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
        attempt.attemptId,
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
        removing(
          attempt.attemptId,
          isolation._tag === "Container"
            ? removeStandalone("cleanup", machine, attempt.attemptId, worktree)
            : Effect.asVoid(
                git([
                  "--git-dir",
                  cachePath(machine, attempt.repository),
                  "worktree",
                  "remove",
                  "--force",
                  worktree,
                ]),
              ),
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
      yield* Effect.annotateCurrentSpan(recoveryFields(attempt));
      yield* session.stopForRecovery(attempt);
      const located = yield* leftoversOf(attempt);
      if (Option.isNone(located)) {
        yield* Effect.logInfo("The Attempt's machine is gone; nothing is left to reconcile", {
          attemptId: attempt.attemptId,
          worker: attempt.worker,
        });
        yield* session.recoverPostedComments(attempt, Option.none(), record);
        return;
      }
      const { machine, checkouts } = located.value;
      const worktree = `${machine.workerDirectory}/attempts/${safeSegment(attempt.attemptId)}`;
      yield* Effect.addFinalizer((exit) => recovered(attempt, Exit.isSuccess(exit)));
      // Checks the cached listing first to avoid an SSH round trip per persisted Attempt.
      const present = checkouts.has(worktree) && (yield* checkoutExists(machine, worktree));
      yield* checkoutHeld(attempt.attemptId, present);
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
                      attempt.attemptId,
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
    }, Effect.scoped);

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
     * Checks that a reattached Attempt's parent task was created for this worktree, the worktree
     * still exists, and `isolation` can run commands in it, then stops children left from before
     * the restart. Returns the parent's RunSpec.
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
      yield* isolationOfCheckout("prepare", machine, request.attemptId, worktree, isolation);
      yield* stopChildren("prepare", machine, worktree, request.attemptId, isolation);
      return spec;
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
          // The only cleanup command in the checkout is the salvage's git.
          Effect.andThen(operation === "cleanup" ? checkout.salvageShell : checkout.shell),
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
          cleanup(
            "worktree-directory",
            removing(
              request.attemptId,
              removeStandalone("cleanup", machine, request.attemptId, worktree),
            ),
          ),
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
            : linkedCheckout(
                request.attemptId,
                linkedWorktree(host, layout, (target, content) =>
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
              ),
      };
    };

    /** Returns `ops` whose removal records the checkout as gone once its directory is removed. */
    const linkedCheckout = (
      attemptId: AttemptId,
      ops: CheckoutOps<ExecutorError>,
    ): CheckoutOps<ExecutorError> => ({
      ...ops,
      remove: (cleanup) =>
        ops.remove((resource, effect) =>
          cleanup(
            resource,
            resource === "worktree-directory" ? removing(attemptId, effect) : effect,
          ),
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
      const machine = yield* attemptMachine(request.worker, request.attemptId);
      const isolation = yield* worker.isolation(machine);
      const probeBrain = (shell: RemoteShell) =>
        verifyHarnessReadiness(
          request.worker,
          machine.provisioned,
          [request.agent.brain],
          worker.harnessProbe(machine, shell),
          logins,
        );
      // An Attempt container doesn't exist yet, so its probe runs once the checkout is prepared.
      if (isolation._tag === "SharedUser") yield* probeBrain(machine.shell);
      const host = machine.shell.destination;
      const cache = cachePath(machine, request.repository);
      const worktree = `${machine.workerDirectory}/attempts/${safeSegment(request.attemptId)}`;
      const staging = `${cache}.cloning`;
      yield* Effect.annotateCurrentSpan({ host, isolation: isolation._tag });
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
          isolation: isolation._tag,
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
        ? Option.some(yield* takeOver(request, machine, worktree, isolation))
        : Option.none();
      const harness = Option.match(reattached, {
        onNone: () => request.agent.brain.harness,
        onSome: (spec) => spec.agent.brain.harness,
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
          onSome: (spec) => reattachWorktree({ request, host, layout: { worktree }, ops, spec }),
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
      yield* checkoutHeld(request.attemptId, true);
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
              yield* checkoutHost.recordOutOfMemory(io.outOfMemory);
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
                machine: machine.provisioned,
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
      sweep: worker.sweep ?? Effect.void,
    });
  });
