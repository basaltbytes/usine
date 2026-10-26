import { RemoteShell, type SshCommand } from "@usine/agents/child-host";
import { supportedCodexVersions } from "@usine/agents/preflight";
import { ClaudeLoginLock } from "@usine/agents/runtime";
import {
  ApiKeyCredential,
  CreateSandbox,
  ProviderGrant,
  SandboxCredentials,
  type SandboxName,
  sandboxName,
  SandboxOwner,
} from "@usine/cloudflare";
import { harnessEnvironment, SANDBOX_HOME } from "@usine/cloudflare/harness";
import type { BrainSpec, Harness } from "@usine/core/agent/brain";
import { HarnessReady, HarnessUnavailableError } from "@usine/core/agent/capability";
import { AttemptId } from "@usine/core/attempt";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptRecovery, AttemptSalvage, RecoverySink } from "@usine/core/attempt/salvage";
import type { LoopPermissions } from "@usine/core/loop";
import { type RepositoryName, safeSegment } from "@usine/core/repository";
import { harvestFacts, harvestPostedComments } from "@usine/core/step/harvest";
import type {
  BotAccount,
  CloudflareLlmProvider,
  GatewayCredentialKind,
  WorkerName,
} from "@usine/core/worker";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
import {
  Array as Arr,
  Cache,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Scope,
} from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { childEnvironment, commitIdentity } from "../child-environment.ts";
import { durableSessionFor, type PostedCommentsHarvest } from "../durable-session.ts";
import {
  type CheckoutRequest,
  CredentialProvider,
  Executor,
  ExecutorError,
  type ExecutorOperation,
  ExecutorOperationError,
  fullPreflight,
  logPreflightFailure,
  WorkerCapabilityError,
} from "../executor.ts";
import { type HarnessProbe, verifyHarnessReadiness } from "../harness-preflight.ts";
import {
  cacheDirectoryName,
  keptCheckoutRecovery,
  linkedWorktree,
  type ProvisionedWorktree,
  provisionWorktree,
  reattachWorktree,
  recoverWorktree,
  type WorkspaceOps,
} from "../provision.ts";
import { type RemoteCommands, remoteCommandsFor } from "../remote/commands.ts";
import { renewableCredential } from "../renewable-credential.ts";
import { type SandboxClient, type SandboxRequestError, sandboxClientFor } from "./client.ts";
import type { CloudflareExecutorOptions, CloudflareWorkerAddress } from "./model.ts";
import { SHELL_ENVIRONMENT, SHELL_FAILURE } from "./shell/environment.ts";

/** The sandbox directory with the cached clone under `repos` and the checkout under `attempts`. */
const WORKSPACE = `${SANDBOX_HOME}/workspace`;

/** The Attempt ID of the sandbox that preflight starts to check the image's harnesses. */
const PREFLIGHT_ATTEMPT = AttemptId.make("preflight");

/** The sandbox shell under this Node.js, next to this module in the built package. */
const DEFAULT_SHELL: SshCommand = {
  command: process.execPath,
  args: [fileURLToPath(new URL("shell/shell.js", import.meta.url))],
};

/** A script that writes `$2` to the file `$1`, creating its directory, and makes it executable. */
const WRITE_EXECUTABLE_SCRIPT = String.raw`
set -e
mkdir -p "$(dirname "$1")"
printf '%s' "$2" > "$1"
chmod 755 "$1"
`.trim();

/** The provider whose API key each harness needs in a sandbox, which holds no harness login. */
const HARNESS_PROVIDERS = {
  claude: Option.some("anthropic"),
  codex: Option.some("openai"),
  pi: Option.none(),
} as const satisfies Record<Harness, Option.Option<CloudflareLlmProvider>>;

const PROVIDER_LABELS = {
  anthropic: "Claude Code needs an Anthropic API key",
  openai: "Codex needs an OpenAI API key",
} as const satisfies Record<CloudflareLlmProvider, string>;

interface CloudflareWorker {
  readonly address: CloudflareWorkerAddress;
  /** This instance's owner of the Worker's sandboxes. */
  readonly owner: SandboxOwner;
  readonly client: SandboxClient;
  readonly providers: ReadonlyArray<CloudflareLlmProvider>;
  /** Returns the shell that runs commands in the sandbox `name`, through the sandbox shell. */
  readonly shellFor: (name: SandboxName) => RemoteShell;
}

/** The sandbox paths of one Attempt's checkout. */
const layoutFor = (repository: RepositoryName, attemptId: AttemptId) => {
  const cache = `${WORKSPACE}/repos/${cacheDirectoryName(repository)}`;
  return {
    cache,
    staging: `${cache}.cloning`,
    worktree: `${WORKSPACE}/attempts/${safeSegment(attemptId)}`,
  } as const;
};

const isExecutorError = Schema.is(ExecutorError);

const operationError =
  (operation: ExecutorOperation) =>
  (error: SandboxRequestError): ExecutorOperationError =>
    new ExecutorOperationError({ operation, message: error.message, cause: error });

/** Returns why `address` can't run `brain`, or `None` if it can. */
const brainGap = (
  address: CloudflareWorkerAddress,
  brain: BrainSpec,
): Option.Option<WorkerCapabilityError> =>
  Option.match(HARNESS_PROVIDERS[brain.harness], {
    onNone: () =>
      Option.some(
        new WorkerCapabilityError({
          worker: address.name,
          capability: "toolchain",
          message: `Cloudflare worker "${address.name}" can't run Pi children, which run only on local workers`,
          cause: new Error(`unsupported harness ${brain.harness}`),
        }),
      ),
    onSome: (provider) =>
      address.providers.some((key) => key.provider === provider)
        ? Option.none()
        : Option.some(
            new WorkerCapabilityError({
              worker: address.name,
              capability: "harness-login",
              message: `${PROVIDER_LABELS[provider]} on cloudflare worker "${address.name}", which holds no harness login. Add ${provider} to the worker's llm_providers with its api_key_env.`,
              cause: new Error(`no ${provider} key`),
            }),
          ),
  });

/** Returns the sandbox credentials of a running Attempt: `github` and every provider key of `address`. */
const credentialsFor = (
  address: CloudflareWorkerAddress,
  github: Redacted.Redacted<string>,
  issuedAt: DateTime.Utc,
) =>
  new SandboxCredentials({
    issuedAt,
    github: Option.some(github),
    providers: address.providers.map(
      ({ provider, apiKey }) =>
        new ProviderGrant({ provider, credential: new ApiKeyCredential({ key: apiKey }) }),
    ),
  });

/**
 * Returns the credentials of a sandbox that runs no Attempt: a preflight's, or one that usine
 * keeps. Its outbound handlers refuse GitHub and every provider.
 */
const noCredentials = (issuedAt: DateTime.Utc) =>
  new SandboxCredentials({ issuedAt, github: Option.none(), providers: [] });

/** The message of the `InfraFailure` of an Attempt whose sandbox the platform stops. */
const DRAIN_MESSAGE =
  "Cloudflare is stopping the attempt's sandbox, whose disk a new container won't have; the attempt salvaged its checkout, and the next attempt resumes from the salvage";

/** A probe that checks a harness's binary and version in a sandbox. Pi never reaches it. */
const versionProbe =
  (
    operation: "preflight" | "prepare",
    commands: RemoteCommands,
    shell: RemoteShell,
  ): HarnessProbe =>
  (brain) =>
    Effect.gen(function* () {
      const command = brain.harness === "codex" ? "codex" : "claude";
      const result = yield* commands.inspect(operation, shell, command, ["--version"]);
      if (result.exitCode === SHELL_FAILURE)
        return yield* new ExecutorOperationError({
          operation,
          message: `Can't reach sandbox ${shell.destination} to run ${command}`,
          cause: new Error(
            result.stderr.trim() || `the sandbox shell exited with ${SHELL_FAILURE}`,
          ),
        });
      const version = result.stdout.trim();
      if (result.exitCode !== 0)
        return new HarnessUnavailableError({
          harness: brain.harness,
          capability: "binary",
          message: `${command} --version failed in the sandbox image`,
        });
      if (
        brain.harness === "codex" &&
        !supportedCodexVersions.some((supported) => version === `codex-cli ${supported}`)
      )
        return new HarnessUnavailableError({
          harness: "codex",
          capability: "version",
          message: `The sandbox image has ${/^codex-cli [0-9]+\.[0-9]+\.[0-9]+$/u.test(version) ? version : "an unrecognized Codex version"}. Rebuild it with a supported Codex CLI version: ${supportedCodexVersions.join(", ")}.`,
        });
      yield* Effect.logInfo("Checked a harness in the sandbox image", {
        sandbox: shell.destination,
        harness: brain.harness,
        version,
      });
      return new HarnessReady({ harness: brain.harness });
    });

const makeCloudflareExecutor = (options: CloudflareExecutorOptions) =>
  Effect.gen(function* () {
    const commands = yield* remoteCommandsFor;
    const credentialProvider = yield* CredentialProvider;
    const logins = yield* ClaudeLoginLock;
    const session = yield* durableSessionFor({
      interruptGrace: options.interruptGrace ?? "10 seconds",
    });
    const shell = options.shell ?? DEFAULT_SHELL;
    const drainPollInterval = options.drainPollInterval ?? "30 seconds";

    const workers = new Map<WorkerName, CloudflareWorker>();
    for (const address of options.workers) {
      if (workers.has(address.name))
        return yield* Effect.die(
          new Error(`CloudflareExecutorOptions.workers names "${address.name}" twice`),
        );
      const owner = yield* Option.match(
        Schema.decodeUnknownOption(SandboxOwner)(`${options.instance}.${address.name}`),
        {
          onNone: () =>
            Effect.die(
              new Error(
                `CloudflareExecutorOptions.instance "${options.instance}" isn't in kebab case`,
              ),
            ),
          onSome: Effect.succeed,
        },
      );
      const client = yield* sandboxClientFor(address, owner);
      const sshEnvironment = {
        ...Object.fromEntries(
          ["HOME", "PATH", "TMPDIR"].flatMap((name) =>
            Option.toArray(
              Option.map(Option.fromNullishOr(process.env[name]), (value) => [name, value]),
            ),
          ),
        ),
        [SHELL_ENVIRONMENT.workerUrl]: address.workerUrl.origin,
        [SHELL_ENVIRONMENT.accessClientId]: Redacted.value(address.accessClientId),
        [SHELL_ENVIRONMENT.accessClientSecret]: Redacted.value(address.accessClientSecret),
      };
      workers.set(address.name, {
        address,
        owner,
        client,
        providers: Arr.dedupe(address.providers.map(({ provider }) => provider)),
        shellFor: (name) => new RemoteShell({ ssh: shell, sshEnvironment, destination: name }),
      });
    }

    const lastIssued = yield* Ref.make(DateTime.makeUnsafe(0));
    /**
     * Returns the time to put on new sandbox credentials: now, or a millisecond after the last
     * ones if the clock reads earlier. A sandbox refuses credentials older than the ones it holds,
     * so this keeps a revocation later than the renewals before it.
     */
    const issueTime = Effect.gen(function* () {
      const now = yield* DateTime.now;
      return yield* Ref.modify(lastIssued, (last) => {
        const issued = DateTime.max(now, DateTime.add(last, { milliseconds: 1 }));
        return [issued, issued] as const;
      });
    });

    /** The sandboxes this process uses now; orphan reconciliation never destroys them. */
    const active = new Set<SandboxName>();
    const claim = (name: SandboxName) =>
      Effect.acquireRelease(
        Effect.sync(() => active.add(name)),
        () => Effect.sync(() => active.delete(name)),
      );

    const workerFor = (operation: ExecutorOperation, name: WorkerName) =>
      Option.match(Option.fromNullishOr(workers.get(name)), {
        onNone: () =>
          Effect.fail(
            new ExecutorOperationError({
              operation,
              message: `No cloudflare worker named "${name}" is configured`,
              cause: new Error(name),
            }),
          ),
        onSome: Effect.succeed,
      });

    /** Returns the variables that point git, gh, and the harnesses at the sandbox's outbound handlers. */
    const sandboxEnvironment = (worker: CloudflareWorker) => harnessEnvironment(worker.providers);

    /** Returns the credential kind the outbound handlers inject for `harness`. */
    const gatewayCredential = (
      worker: CloudflareWorker,
      harness: Harness,
    ): Option.Option<GatewayCredentialKind> =>
      Option.flatMap(HARNESS_PROVIDERS[harness], (provider) =>
        worker.providers.includes(provider) ? Option.some("api-key" as const) : Option.none(),
      );

    const destroySandbox = Effect.fn("CloudflareExecutor.destroySandbox")(function* (
      worker: CloudflareWorker,
      name: SandboxName,
      reason: string,
    ) {
      yield* Effect.annotateCurrentSpan({ worker: worker.address.name, sandbox: name });
      const { destroyed } = yield* worker.client
        .destroy(name)
        .pipe(Effect.mapError(operationError("cleanup")));
      yield* Effect.logInfo(destroyed ? "Destroyed the sandbox" : "The sandbox was already gone", {
        worker: worker.address.name,
        sandbox: name,
        reason,
      });
    });

    /**
     * Holds the sandbox, whose checkout stays, so that the Worker keeps its container running
     * until usine reconciles or destroys it. Logs a failure, after which the container stops two
     * hours after the sandbox's last request.
     */
    const holdSandbox = Effect.fn("CloudflareExecutor.holdSandbox")(function* (
      worker: CloudflareWorker,
      name: SandboxName,
      reason: string,
    ) {
      const fields = { worker: worker.address.name, sandbox: name, reason };
      yield* Effect.annotateCurrentSpan(fields);
      yield* worker.client.hold(name).pipe(
        Effect.tap(() =>
          Effect.logInfo("Holding the sandbox until usine reconciles or destroys it", fields),
        ),
        Effect.tapError((error) =>
          Effect.logError(
            "Could not hold the sandbox; its container and checkout stop two hours after its last request",
            { ...fields, message: error.message },
          ),
        ),
        Effect.ignore,
      );
    });

    /**
     * Returns whether the platform is stopping the sandbox's container. Logs a failed request and
     * returns false, so the next poll asks again.
     */
    const isDraining = Effect.fn("CloudflareExecutor.isDraining")(function* (
      worker: CloudflareWorker,
      name: SandboxName,
    ) {
      yield* Effect.annotateCurrentSpan({ worker: worker.address.name, sandbox: name });
      return yield* worker.client.get(name).pipe(
        Effect.map(Option.exists(({ draining }) => draining)),
        Effect.tapError((error) =>
          Effect.logWarning("Could not ask whether the sandbox is draining; asking again", {
            worker: worker.address.name,
            sandbox: name,
            message: error.message,
          }),
        ),
        Effect.orElseSucceed(() => false),
      );
    });

    /**
     * Asks every `drainPollInterval` whether the platform is stopping the Attempt's sandbox, and
     * drains the Attempt when it is: the Attempt fails with a retryable `InfraFailure`, and its
     * release salvages the checkout within the platform's 15 minutes.
     */
    const watchDrain = (worker: CloudflareWorker, name: SandboxName, attemptId: AttemptId) =>
      Effect.sleep(drainPollInterval).pipe(
        Effect.andThen(isDraining(worker, name)),
        Effect.repeat({ until: (draining) => draining }),
        Effect.andThen(session.drain(attemptId, DRAIN_MESSAGE)),
        Effect.tapError((error) =>
          Effect.logError("Could not drain the Attempt whose sandbox the platform stops", {
            attemptId,
            worker: worker.address.name,
            sandbox: name,
            message: error.message,
          }),
        ),
        Effect.ignore,
      );

    /** Stops every command that still runs in the sandbox, which reads its process files. */
    const stopCommands = Effect.fn("CloudflareExecutor.stopCommands")(function* (
      operation: ExecutorOperation,
      worker: CloudflareWorker,
      name: SandboxName,
    ) {
      yield* Effect.annotateCurrentSpan({ worker: worker.address.name, sandbox: name });
      const { stopped } = yield* worker.client
        .stop(name)
        .pipe(Effect.mapError(operationError(operation)));
      yield* Effect.logInfo("Confirmed no command of the Attempt runs in its sandbox", {
        worker: worker.address.name,
        sandbox: name,
        stopped,
      });
    });

    /** Returns whether `path` exists in the sandbox. */
    const exists = Effect.fn("CloudflareExecutor.exists")(function* (
      operation: ExecutorOperation,
      worker: CloudflareWorker,
      name: SandboxName,
      path: string,
    ) {
      const inspected = yield* commands.inspect(operation, worker.shellFor(name), "test", [
        "-e",
        path,
      ]);
      if (inspected.exitCode === 0) return true;
      if (inspected.exitCode === 1) return false;
      return yield* new ExecutorOperationError({
        operation,
        message: `Can't inspect sandbox ${name}`,
        cause: new Error(
          inspected.stderr.trim() || `test exited with ${String(inspected.exitCode)}`,
        ),
      });
    });

    /**
     * Creates the sandbox `name` for `attempt` from the Worker's image without credentials, so
     * that it reaches neither GitHub nor a provider until `acquireSandbox` grants credentials.
     */
    const createSandbox = Effect.fn("CloudflareExecutor.createSandbox")(function* (
      operation: "preflight" | "prepare",
      worker: CloudflareWorker,
      name: SandboxName,
      attempt: AttemptId,
    ) {
      const fields = {
        worker: worker.address.name,
        sandbox: name,
        attemptId: attempt,
        image: worker.address.image,
        instanceType: worker.address.instanceType,
      };
      yield* Effect.annotateCurrentSpan(fields);
      yield* worker.client
        .create(
          name,
          new CreateSandbox({
            owner: worker.owner,
            attempt,
            image: worker.address.image,
            instanceType: worker.address.instanceType,
            credentials: noCredentials(yield* issueTime),
          }),
        )
        .pipe(Effect.mapError(operationError(operation)));
      yield* Effect.logInfo("Created the sandbox without credentials", fields);
    });

    /**
     * Gives the Attempt's existing sandbox a new installation token and the provider keys, and
     * publishes a new token before each expiry until the caller's scope closes. Then revokes the
     * sandbox's credentials, before the caller holds or destroys the sandbox, so a sandbox that
     * stays, or whose destroy fails, holds none.
     */
    const acquireSandbox = Effect.fn("CloudflareExecutor.acquireSandbox")(function* (
      worker: CloudflareWorker,
      name: SandboxName,
      attemptId: AttemptId,
      repository: RepositoryName,
      permissions: LoopPermissions,
      operation: ExecutorOperation,
    ) {
      const fields = { worker: worker.address.name, sandbox: name, attemptId, repository };
      yield* Effect.annotateCurrentSpan(fields);
      yield* Effect.addFinalizer(() =>
        issueTime.pipe(
          Effect.flatMap((issuedAt) => worker.client.credentials(name, noCredentials(issuedAt))),
          Effect.tap(() => Effect.logInfo("Revoked the sandbox's credentials", fields)),
          Effect.tapError((error) =>
            Effect.logError(
              "Could not revoke the sandbox's credentials; the installation token expires within the hour",
              { ...fields, message: error.message },
            ),
          ),
          Effect.ignore,
        ),
      );
      const publish = (token: Redacted.Redacted<string>) =>
        issueTime.pipe(
          Effect.flatMap((issuedAt) =>
            worker.client.credentials(name, credentialsFor(worker.address, token, issuedAt)),
          ),
          Effect.mapError(operationError(operation)),
        );
      const credential = yield* renewableCredential(
        credentialProvider.issue,
        repository,
        attemptId,
        permissions,
        ({ value }) => publish(value),
      );
      return { refresh: credential.refresh(), scrub: credential.scrub };
    });

    type SandboxAccess = Effect.Success<ReturnType<typeof acquireSandbox>>;

    /** Runs git in the sandbox with the handlers' environment and `author` as author and committer. */
    const sandboxGit =
      (
        operation: ExecutorOperation,
        worker: CloudflareWorker,
        name: SandboxName,
        access: Option.Option<SandboxAccess>,
        author: Option.Option<BotAccount>,
      ) =>
      (args: ReadonlyArray<string>) =>
        Option.match(access, { onNone: () => Effect.void, onSome: ({ refresh }) => refresh }).pipe(
          Effect.andThen(
            commands.run(operation, worker.shellFor(name), "git", args, {
              environment: {
                ...sandboxEnvironment(worker),
                ...Option.match(author, { onNone: () => ({}), onSome: commitIdentity }),
              },
              scrub: Option.match(access, {
                onNone: () => (text: string) => text,
                onSome: ({ scrub }) => scrub,
              }),
            }),
          ),
        );

    const harvestCommand =
      (
        operation: ExecutorOperation,
        worker: CloudflareWorker,
        name: SandboxName,
        worktree: string,
        access: SandboxAccess,
      ) =>
      (command: "git" | "gh", args: ReadonlyArray<string>) =>
        access.refresh.pipe(
          Effect.andThen(
            commands.run(operation, worker.shellFor(name), command, args, {
              cwd: worktree,
              environment: sandboxEnvironment(worker),
              scrub: access.scrub,
            }),
          ),
          Effect.map((stdout) => (stdout === "" ? [] : stdout.replace(/\n$/u, "").split("\n"))),
        );

    /**
     * Stops the commands in `attempt`'s sandbox, salvages its checkout with a new credential,
     * records the salvage, and removes the checkout once its work is pushed. Returns whether the
     * salvage kept unpushed work in the sandbox.
     */
    const reconcileCheckout = Effect.fn("CloudflareExecutor.reconcileCheckout")(function* <E, A>(
      attempt: AttemptRecovery,
      worker: CloudflareWorker,
      name: SandboxName,
      record: RecoverySink<E>["salvage"],
      commitAuthor: Effect.Effect<BotAccount, A>,
    ) {
      yield* Effect.annotateCurrentSpan({
        attemptId: attempt.attemptId,
        worker: attempt.worker,
        sandbox: name,
      });
      const layout = layoutFor(attempt.repository, attempt.attemptId);
      const retained = yield* Ref.make(false);
      const recordSalvage = (salvage: AttemptSalvage) =>
        Ref.set(retained, salvage._tag !== "Pushed").pipe(Effect.andThen(record(salvage)));
      const reconcile = (
        git: (args: ReadonlyArray<string>) => Effect.Effect<string, ExecutorError>,
      ) =>
        recoverWorktree(
          {
            attempt,
            host: name,
            worktree: layout.worktree,
            git,
            removeCheckout: Effect.asVoid(
              git(["--git-dir", layout.cache, "worktree", "remove", "--force", layout.worktree]),
            ),
          },
          recordSalvage,
        );
      if (attempt.succeeded || attempt.permissions === "read") {
        yield* stopCommands("cleanup", worker, name);
        yield* reconcile(sandboxGit("cleanup", worker, name, Option.none(), Option.none()));
        return false;
      }
      const author = yield* commitAuthor;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const access = yield* acquireSandbox(
            worker,
            name,
            attempt.attemptId,
            attempt.repository,
            attempt.permissions,
            "cleanup",
          );
          yield* stopCommands("cleanup", worker, name);
          yield* reconcile(
            sandboxGit("cleanup", worker, name, Option.some(access), Option.some(author)),
          );
        }),
      );
      return yield* Ref.get(retained);
    });

    /**
     * Destroys every sandbox of `worker` that this process doesn't use and that holds no
     * checkout: one whose container stopped, which lost its disk, or one without an Attempt
     * checkout, such as a failed preparation's or a preflight's. A sandbox with a checkout stays
     * for durable recovery.
     */
    const reconcileOrphans = Effect.fn("CloudflareExecutor.reconcileOrphans")(function* (
      worker: CloudflareWorker,
    ) {
      const fields = { worker: worker.address.name, owner: worker.owner };
      yield* Effect.annotateCurrentSpan(fields);
      const { sandboxes } = yield* worker.client.list.pipe(
        Effect.mapError(operationError("cleanup")),
      );
      const candidates = sandboxes.filter(({ name }) => !active.has(name));
      const destroyed = yield* Effect.forEach(
        candidates,
        (sandbox) =>
          Effect.gen(function* () {
            const holdsCheckout =
              sandbox.running &&
              (yield* commands
                .inspect("cleanup", worker.shellFor(sandbox.name), "sh", [
                  "-c",
                  'test -n "$(ls -A "$1" 2>/dev/null)"',
                  "sh",
                  `${WORKSPACE}/attempts`,
                ])
                .pipe(Effect.map(({ exitCode }) => exitCode !== 1)));
            if (holdsCheckout || active.has(sandbox.name)) {
              yield* Effect.logWarning(
                "Keeping a sandbox that holds a checkout for its Attempt's durable recovery",
                { ...fields, sandbox: sandbox.name, attemptId: sandbox.attempt },
              );
              return false;
            }
            yield* destroySandbox(
              worker,
              sandbox.name,
              sandbox.running
                ? "an orphan sandbox without a checkout"
                : "an orphan sandbox whose container stopped",
            );
            return true;
          }).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "Could not reconcile an orphan sandbox; it stays until the next start",
                {
                  ...fields,
                  sandbox: sandbox.name,
                  message: error.message,
                },
              ),
            ),
            Effect.orElseSucceed(() => false),
          ),
        { concurrency: 4 },
      );
      yield* Effect.logInfo("Reconciled the Worker's orphan sandboxes", {
        ...fields,
        listed: sandboxes.length,
        destroyed: destroyed.filter(Boolean).length,
      });
    });

    // Once per Worker per process; a failure is logged and the next start retries it.
    const orphansReconciled = yield* Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (name: WorkerName) =>
        workerFor("cleanup", name).pipe(
          Effect.flatMap(reconcileOrphans),
          Effect.tapError((error) =>
            Effect.logWarning(
              "Could not list the Worker's sandboxes; orphans stay until the next start",
              {
                worker: name,
                message: error.message,
              },
            ),
          ),
          Effect.ignore,
        ),
    });

    const recover = Effect.fn("CloudflareExecutor.recover")(function* <E, A>(
      attempt: AttemptRecovery,
      record: RecoverySink<E>,
      commitAuthor: Effect.Effect<BotAccount, A>,
    ) {
      yield* Effect.annotateCurrentSpan({ ...attempt, rejected: Option.isSome(attempt.rejected) });
      yield* session.stopForRecovery(attempt);
      const worker = yield* workerFor("cleanup", attempt.worker);
      const name = sandboxName(worker.owner, attempt.attemptId);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* claim(name);
          yield* Cache.get(orphansReconciled, attempt.worker);
          const summary = yield* worker.client
            .get(name)
            .pipe(Effect.mapError(operationError("cleanup")));
          const layout = layoutFor(attempt.repository, attempt.attemptId);
          const present =
            Option.exists(summary, ({ running }) => running) &&
            (yield* exists("cleanup", worker, name, layout.worktree));
          yield* session.recoverPostedComments(
            attempt,
            present
              ? Option.some<PostedCommentsHarvest>((spec, windows) =>
                  Effect.scoped(
                    Effect.gen(function* () {
                      const access = yield* acquireSandbox(
                        worker,
                        name,
                        attempt.attemptId,
                        attempt.repository,
                        attempt.permissions,
                        "cleanup",
                      );
                      return yield* harvestPostedComments(
                        spec,
                        harvestCommand("cleanup", worker, name, layout.worktree, access),
                        windows,
                      );
                    }),
                  ),
                )
              : Option.none(),
            record,
          );
          if (Option.isNone(summary)) {
            yield* Effect.logInfo("The Attempt's sandbox is gone; nothing to reconcile", {
              attemptId: attempt.attemptId,
              sandbox: name,
            });
            return;
          }
          if (!present) {
            yield* destroySandbox(worker, name, "its checkout is gone");
            return;
          }
          const retained = yield* reconcileCheckout(
            attempt,
            worker,
            name,
            record.salvage,
            commitAuthor,
          );
          if (retained) {
            yield* Effect.logWarning("Keeping the sandbox, whose checkout holds unpushed work", {
              attemptId: attempt.attemptId,
              sandbox: name,
            });
            yield* holdSandbox(worker, name, "its checkout holds unpushed work");
          } else yield* destroySandbox(worker, name, "its checkout was reconciled");
        }),
      );
    });

    const preflight = Effect.fn("CloudflareExecutor.preflight")(function* (
      workerName: WorkerName,
      brains: ReadonlyArray<BrainSpec>,
      _maxConcurrentAttempts: number,
    ) {
      yield* Effect.annotateCurrentSpan({ worker: workerName });
      const worker = yield* workerFor("preflight", workerName);
      const { address } = worker;
      const health = yield* worker.client.health.pipe(
        Effect.mapError((error) =>
          error.refused
            ? new WorkerCapabilityError({
                worker: workerName,
                capability: "credentials",
                message: `The Cloudflare Worker at ${address.workerUrl.origin} refused the Access service token of cloudflare worker "${workerName}". Check the variables that access_client_id_env and access_client_secret_env name, and the Worker's ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET secrets.`,
                cause: error,
              })
            : operationError("preflight")(error),
        ),
      );
      if (!health.images.includes(address.image))
        return yield* new WorkerCapabilityError({
          worker: workerName,
          capability: "toolchain",
          message: `The Cloudflare Worker at ${address.workerUrl.origin} has no image "${address.image}", which cloudflare worker "${workerName}" names; it has ${health.images.join(", ") || "none"}.`,
          cause: new Error(`images: ${health.images.join(",")}`),
        });
      const distinct = Arr.dedupe(brains);
      for (const brain of distinct) {
        const gap = brainGap(address, brain);
        if (Option.isSome(gap)) return yield* gap.value;
      }
      if (distinct.length > 0) {
        const name = sandboxName(worker.owner, PREFLIGHT_ATTEMPT);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* claim(name);
            yield* Effect.addFinalizer(() =>
              destroySandbox(worker, name, "preflight checked the image").pipe(
                Effect.tapError((error) =>
                  Effect.logWarning(
                    "Could not destroy the preflight sandbox; the next start reconciles it",
                    {
                      worker: workerName,
                      message: error.message,
                    },
                  ),
                ),
                Effect.ignore,
              ),
            );
            yield* createSandbox("preflight", worker, name, PREFLIGHT_ATTEMPT);
            yield* verifyHarnessReadiness(
              workerName,
              distinct,
              versionProbe("preflight", commands, worker.shellFor(name)),
              logins,
            );
          }),
        );
      }
      yield* Effect.logInfo("Cloudflare Worker preflight verified", {
        worker: workerName,
        workerUrl: address.workerUrl.origin,
        image: address.image,
        protocol: health.protocol,
        providers: worker.providers.join(","),
      });
      // Each Attempt has a sandbox of its own, so none shares a machine with another.
      return fullPreflight;
    }, logPreflightFailure);

    const prepare = Effect.fn("CloudflareExecutor.prepare")(function* (request: CheckoutRequest) {
      const fields = {
        attemptId: request.attemptId,
        worker: request.worker,
        repository: request.repository,
        loop: request.loop,
        permissions: request.permissions,
        reattach: request.reattach,
      };
      yield* Effect.annotateCurrentSpan(fields);
      const worker = yield* workerFor("prepare", request.worker);
      const gap = brainGap(worker.address, request.agent.brain);
      if (Option.isSome(gap)) {
        yield* Effect.logWarning("Refused an Attempt whose brain the sandbox can't run", {
          ...fields,
          message: gap.value.message,
        });
        return yield* gap.value;
      }
      const name = sandboxName(worker.owner, request.attemptId);
      const layout = layoutFor(request.repository, request.attemptId);
      const shell = worker.shellFor(name);
      yield* claim(name);
      yield* Cache.get(orphansReconciled, request.worker);
      yield* Effect.logInfo(
        request.reattach
          ? "Reattaching the Attempt to its cloudflare sandbox"
          : "Preparing cloudflare Attempt sandbox",
        { ...fields, sandbox: name, worktree: layout.worktree },
      );

      // A reattachment reuses its sandbox and checkout before any credential is granted.
      const reattached = request.reattach
        ? Option.some(
            yield* Effect.gen(function* () {
              const summary = yield* worker.client
                .get(name)
                .pipe(Effect.mapError(operationError("prepare")));
              if (!Option.exists(summary, ({ running }) => running))
                return yield* new ExecutorOperationError({
                  operation: "prepare",
                  message:
                    "The reattached attempt's sandbox no longer runs, so its checkout is gone",
                  cause: new Error(name),
                });
              const { cwd, spec } = yield* session.storedRequest(request.attemptId);
              if (cwd !== layout.worktree)
                return yield* new ExecutorOperationError({
                  operation: "prepare",
                  message: "The reattached attempt's checkout isn't in its cloudflare sandbox",
                  cause: new Error(cwd),
                });
              if (!(yield* exists("prepare", worker, name, layout.worktree)))
                return yield* new ExecutorOperationError({
                  operation: "prepare",
                  message: "The reattached attempt's checkout no longer exists",
                  cause: new Error(layout.worktree),
                });
              yield* stopCommands("prepare", worker, name);
              return spec;
            }),
          )
        : Option.none();

      /** Set when the sandbox must stay: its checkout is kept, or its work isn't all pushed. */
      const keep = yield* Ref.make(false);
      const salvaged = yield* Deferred.make<Option.Option<AttemptSalvage>, AttemptFailure>();

      // Added before `acquire`, so it runs last: after the checkout's release, and after
      // `acquireSandbox` revoked the credentials, so a sandbox that stays holds none.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const salvage = (yield* Deferred.isDone(salvaged))
            ? Option.some(yield* Effect.exit(Deferred.await(salvaged)))
            : Option.none();
          const retained =
            (yield* Ref.get(keep)) ||
            Option.match(salvage, {
              // Preparation failed before it acquired the checkout. A reattachment's checkout
              // existed before, with the Attempt's work, and the engine's recovery salvages it.
              onNone: () => request.reattach,
              onSome: (exit) =>
                Exit.isFailure(exit) || Option.exists(exit.value, ({ _tag }) => _tag !== "Pushed"),
            });
          if (retained) {
            yield* Effect.logInfo("Keeping the Attempt's sandbox with its checkout", {
              ...fields,
              sandbox: name,
              salvaged: Option.isSome(salvage),
            });
            yield* holdSandbox(worker, name, "the Attempt's checkout stays");
            return;
          }
          yield* destroySandbox(worker, name, "the Attempt's resources were released").pipe(
            Effect.tapError((error) =>
              Effect.logError(
                "Could not destroy the Attempt's sandbox; the next start reconciles it",
                { ...fields, sandbox: name, message: error.message },
              ),
            ),
            Effect.ignore,
          );
        }),
      );

      const acquire = Effect.gen(function* () {
        // A new sandbox's harness is checked before any credential is granted; a reattached
        // sandbox is the container that was checked when it was created.
        if (!request.reattach) {
          yield* createSandbox("prepare", worker, name, request.attemptId);
          yield* verifyHarnessReadiness(
            request.worker,
            [request.agent.brain],
            versionProbe("prepare", commands, shell),
            logins,
          );
        }
        const access = yield* acquireSandbox(
          worker,
          name,
          request.attemptId,
          request.repository,
          request.permissions,
          "prepare",
        );
        const host = {
          removePath: (operation: ExecutorOperation, target: string) =>
            Effect.asVoid(commands.run(operation, shell, "rm", ["-rf", target])),
          cacheExists: exists("prepare", worker, name, layout.cache),
          git: (operation: "prepare" | "cleanup", args: ReadonlyArray<string>) =>
            sandboxGit(
              operation,
              worker,
              name,
              Option.some(access),
              Option.some(request.commitAuthor),
            )(args),
        };
        const ops: WorkspaceOps<ExecutorError> = {
          ...host,
          ensureRoots: Effect.asVoid(
            commands.run("prepare", shell, "mkdir", [
              "-p",
              `${WORKSPACE}/repos`,
              `${WORKSPACE}/attempts`,
            ]),
          ),
          promoteStaging: Effect.asVoid(
            commands.run("prepare", shell, "mv", [layout.staging, layout.cache]),
          ),
          checkout: linkedWorktree(host, layout, (target, content) =>
            Effect.asVoid(
              commands.run("prepare", shell, "sh", [
                "-c",
                WRITE_EXECUTABLE_SCRIPT,
                "sh",
                target,
                content,
              ]),
            ),
          ),
        };
        const checkout = Option.match(reattached, {
          onNone: () =>
            provisionWorktree({
              request,
              url: `https://github.com/${request.repository}.git`,
              host: name,
              layout,
              ops,
            }),
          onSome: (spec) =>
            reattachWorktree({
              request,
              host: name,
              layout: { worktree: layout.worktree },
              ops,
              spec,
            }),
        });
        const releaseWorkspace = Effect.fn("CloudflareExecutor.releaseWorkspace")(
          function* (
            resource: {
              readonly provisioned: ProvisionedWorktree;
              readonly scope: Scope.Closeable;
            },
            exit: Exit.Exit<unknown, unknown>,
          ) {
            yield* Effect.annotateCurrentSpan({ ...fields, sandbox: name });
            // Closes the checkout scope only if stopping the sandbox's commands succeeds.
            yield* stopCommands("cleanup", worker, name);
            yield* Scope.close(resource.scope, exit);
            yield* Deferred.done(salvaged, yield* Effect.exit(resource.provisioned.salvaged));
          },
          (effect) =>
            effect.pipe(
              Effect.tapError((error) =>
                Effect.logError(
                  "Stopping the sandbox's commands failed; its checkout stays for recovery",
                  {
                    ...fields,
                    sandbox: name,
                    message: error.message,
                  },
                ).pipe(Effect.andThen(Ref.set(keep, true))),
              ),
              Effect.ignore,
              // Completes the salvage result if the stop failed before the checkout scope closed.
              Effect.andThen(Deferred.succeed(salvaged, Option.none())),
            ),
        );
        const { provisioned } = yield* Effect.acquireRelease(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
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
      const { provisioned, access } = yield* acquire.pipe(
        Effect.mapError((cause) =>
          isExecutorError(cause)
            ? cause
            : new ExecutorOperationError({
                operation: "prepare",
                message: "Can't prepare the cloudflare attempt sandbox",
                cause,
              }),
        ),
      );
      const prepared = provisioned.workspace;
      yield* Effect.logInfo("Cloudflare Attempt sandbox ready", {
        ...fields,
        sandbox: name,
        baseCommit: prepared.spec.baseCommit,
        worktree: layout.worktree,
      });
      const keptWith = (kept: Effect.Effect<void>) =>
        Ref.set(keep, true).pipe(Effect.andThen(kept));
      const launchIn = (io: AttemptChannel.Sink) =>
        session.launch(prepared, io, {
          host: shell,
          environment: childEnvironment(
            sandboxEnvironment(worker),
            request.commitAuthor,
            provisioned.gitHooks,
          ),
          gatewayCredential: Effect.succeed(
            gatewayCredential(worker, prepared.spec.agent.brain.harness),
          ),
          harvest: (windows) =>
            harvestFacts(
              prepared.spec,
              harvestCommand("launch", worker, name, prepared.worktree, access),
              windows,
            ).pipe(
              Effect.mapError(
                (error) =>
                  new InfraFailure({
                    message: `Can't harvest the attempt's checkout: ${error.message}`,
                    cause: error,
                  }),
              ),
            ),
          harvestComments: (windows) =>
            harvestPostedComments(
              prepared.spec,
              harvestCommand("launch", worker, name, prepared.worktree, access),
              windows,
            ),
          keepForReattach: keptWith(provisioned.keepForReattach),
          keepUntilStopped: keptWith(provisioned.keepUntilStopped),
          reconcileKept: (record) =>
            Effect.gen(function* () {
              const summary = yield* worker.client
                .get(name)
                .pipe(Effect.mapError(operationError("cleanup")));
              if (!Option.exists(summary, ({ running }) => running)) {
                yield* Effect.logInfo("The kept sandbox is gone or stopped; nothing to reconcile", {
                  ...fields,
                  sandbox: name,
                });
                if (Option.isSome(summary))
                  yield* destroySandbox(worker, name, "its container stopped");
                return;
              }
              const retained = yield* reconcileCheckout(
                keptCheckoutRecovery(request),
                worker,
                name,
                record,
                Effect.succeed(request.commitAuthor),
              );
              if (retained)
                yield* holdSandbox(worker, name, "its kept checkout holds unpushed work");
              else yield* destroySandbox(worker, name, "its kept checkout was reconciled");
            }),
        });
      return {
        workspace: prepared,
        launch: (io: AttemptChannel.Sink) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* watchDrain(worker, name, request.attemptId).pipe(Effect.forkScoped);
              return yield* launchIn(io);
            }),
          ),
        salvaged: Deferred.await(salvaged),
        recordSalvage: provisioned.recordSalvage,
      };
    }, session.prepare);

    return Executor.of({
      kind: "cloudflare",
      recover,
      cancel: session.cancel,
      intervene: session.intervene,
      isLive: session.isLive,
      outcome: session.outcome,
      preflight,
      prepare,
    });
  });

/**
 * The executor for `cloudflare` Workers. Each Attempt runs in its own sandbox, which the
 * Worker deployed from `@usine/cloudflare` creates; its Pi parent is a durable task in this
 * process (`AttemptRuntime`), and each child and git command runs in the sandbox through the
 * sandbox shell. A live Attempt reattaches to its sandbox after an orchestrator restart.
 * Requires Node.
 */
export const layer = (
  options: CloudflareExecutorOptions,
): Layer.Layer<
  Executor,
  never,
  | AttemptRuntime
  | ClaudeLoginLock
  | ChildProcessSpawner.ChildProcessSpawner
  | CredentialProvider
  | HttpClient.HttpClient
> => Layer.effect(Executor, makeCloudflareExecutor(options));

export type {
  CloudflareExecutorOptions,
  CloudflareProviderKey,
  CloudflareWorkerAddress,
} from "./model.ts";
