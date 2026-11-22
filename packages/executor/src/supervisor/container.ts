import { CONTAINER_LIMITS_SCRIPT } from "../container-limits.ts";
import { NodeHttpServer } from "@effect/platform-node";
import { ExecShell, type ExecTransport } from "@usine/agents/child-host";
import { catalog, type CredentialRoute, type HarnessCredential } from "@usine/agents/harness";
import { WorkingDirectory } from "@usine/agents/runtime";
import {
  type SandboxRequest,
  SupervisorSandbox,
  type SupervisorSandboxService,
  SupervisorSeat,
  SupervisorUnavailable,
} from "@usine/agents/supervisor";
import type { Harness, ModelId } from "@usine/core/agent/brain";
import type { ModelProvider } from "@usine/core/agent/provider";
import { conversationKey, type ConversationKey } from "./names.ts";
import { confinedDirectory } from "./confine.ts";
import { bindMount, mountField } from "../bind-mount.ts";
import { prepareImage } from "./image.ts";
import { ConversationHomes } from "./homes/homes.ts";
import {
  archiveHome,
  checkWorkspaceSize,
  memoryShortfall,
  removeFuseStorage,
  restoreHome,
  type SandboxContainer,
} from "./storage.ts";
import { type ContainerImage, SupervisorLimits, WorkerName } from "@usine/core/worker";
import {
  Array as Arr,
  type Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Random,
  Result,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { collectCommand } from "../child-command.ts";
import { type ContainerRuntime, runtimeOptions } from "../remote/runtime.ts";
import type { GatewayModelError, GatewayModelRoute } from "../ssh/gateway/model-route.ts";
import { modelRelayServer, relayModelRequest } from "./model-relay.ts";
import { noNewPrivileges, ROOTLESS_PODMAN_REFUSAL } from "./privileges.ts";
import { detectSandboxRuntime, type SandboxRuntime } from "./detect.ts";

/** The port inside the sandbox on which the model relay listens, on the loopback address. */
export const MODEL_RELAY_PORT = 8787;

/** The directory inside the sandbox that holds the model relay's socket. */
const RELAY_DIRECTORY = "/run/usine";

/** The value of the harness's token variable: the route adds the instance's credential. */
const SANDBOX_TOKEN = "usine-supervisor-sandbox";

/** How often the sandbox's main process checks that the orchestrator still serves the relay. */
const RELAY_CHECK_INTERVAL_MILLIS = 5_000;

/**
 * The sandbox's main process: forwards each connection to the model relay port to the relay's
 * socket, which the orchestrator serves. The container has no other network. The heartbeat is
 * best effort; label-based cleanup owns container removal even if a session stops this process.
 */
const RELAY_SCRIPT = String.raw`
const net = require("node:net");
const [port, socket, interval] = process.argv.slice(1);
net
  .createServer((client) => {
    const upstream = net.connect(socket);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  })
  .listen(Number(port), "127.0.0.1");
setInterval(() => {
  net
    .connect(socket)
    .on("connect", function () {
      this.destroy();
    })
    .on("error", () => process.exit(0));
}, Number(interval));
`;

/** Exits with 0 once the model relay accepts connections, and with 1 if it refuses them. */
const RELAY_PROBE = String.raw`
require("node:net")
  .connect(Number(process.argv[1]), "127.0.0.1")
  .on("connect", () => process.exit(0))
  .on("error", () => process.exit(1));
`;

/** How long a new sandbox's model relay has to accept connections. */
const RELAY_START_TIMEOUT = "30 seconds";

/** How long a turn waits for the startup check before it asks the member to retry. */
const READY_TIMEOUT = "30 seconds";

/** How long the copy of a conversation's home out of its sandbox may take. */
const SAVE_TIMEOUT = "2 minutes";

/** How long the startup check's container may take, from its start to its removal. */
const CHECK_TIMEOUT = "2 minutes";

/** The label whose value is the sandbox root of the orchestrator that started the container. */
const ROOT_LABEL = "usine.supervisor.root";

/** The label whose value is the conversation that the container runs a turn of. */
const CONVERSATION_LABEL = "usine.supervisor.conversation";

/** The value of the conversation label on the startup check's container. */
const CHECK_CONVERSATION = "usine-startup-check";

/** The startup check container's main process, which waits until the check removes it. */
const IDLE_SCRIPT = "setInterval(() => {}, 60_000);";

/** The user that the container's processes run as, so that files they write belong to this host user. */
const userOptions = ({ runtime, rootless }: SandboxRuntime): ReadonlyArray<string> => {
  const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  if (runtime === "podman") return [...runtimeOptions(runtime), "--user", owner];
  // Root in a rootless Docker container is the host user.
  return rootless ? ["--user", "0:0", "--env", "IS_SANDBOX=1"] : ["--user", owner];
};

/** The paths of one conversation, which are the same on the orchestrator and in its sandbox. */
interface ConversationPaths {
  /**
   * In the sandbox: an in-memory filesystem of `conversation_size_mib` that holds `home` and the
   * PID files of the session's processes.
   */
  readonly root: string;
  /** In the sandbox: the harness's home directory, with its saved sessions. */
  readonly home: string;
  /**
   * On the orchestrator, mounted read-only in the sandbox: the session's working directory, with
   * one source directory per repository.
   */
  readonly workspace: string;
}

const conversationPaths = (root: string): ConversationPaths => ({
  root,
  home: `${root}/home`,
  workspace: `${root}/workspace`,
});

/** The arguments of `<runtime> run` that start a sandbox with `main` as its Node.js arguments. */
const containerArguments = (options: {
  readonly name: string;
  readonly root: string;
  readonly conversation: string;
  readonly runtime: SandboxRuntime;
  readonly image: ContainerImage;
  readonly paths: ConversationPaths;
  readonly limits: SupervisorLimits;
  readonly mounts: ReadonlyArray<string>;
  readonly main: ReadonlyArray<string>;
}): ReadonlyArray<string> => {
  const { paths, limits } = options;
  return [
    "run",
    "--detach",
    "--pull",
    "never",
    "--rm",
    "--name",
    options.name,
    "--label",
    `${ROOT_LABEL}=${options.root}`,
    "--label",
    `${CONVERSATION_LABEL}=${options.conversation}`,
    "--init",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${limits.tmpfsSizeMib}m`,
    "--pids-limit",
    String(limits.pids),
    "--memory",
    `${limits.memoryMib}m`,
    "--memory-swap",
    `${limits.memoryMib}m`,
    "--cpus",
    String(limits.cpus),
    "--shm-size",
    "16m",
    "--log-driver",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...userOptions(options.runtime),
    "--env",
    `HOME=${paths.home}`,
    "--workdir",
    paths.workspace,
    "--mount",
    [
      "type=tmpfs",
      mountField("destination", paths.root),
      `tmpfs-size=${limits.conversationSizeMib * 1024 ** 2}`,
      "tmpfs-mode=1777",
    ].join(","),
    "--mount",
    bindMount(paths.workspace, paths.workspace, "readonly"),
    ...options.mounts.flatMap((mount) => ["--mount", mount]),
    "--entrypoint",
    "node",
    options.image,
    ...options.main,
  ];
};

/** The arguments of `<runtime> run` that start one turn's sandbox in the background. */
export const sandboxRunArguments = (options: {
  readonly name: string;
  /** The orchestrator's sandbox root, which the container's label names. */
  readonly root: string;
  readonly conversation: string;
  readonly runtime: SandboxRuntime;
  readonly image: ContainerImage;
  readonly paths: ConversationPaths;
  readonly sources: SandboxRequest["sources"];
  readonly relayDirectory: string;
  readonly limits?: SupervisorLimits;
}): ReadonlyArray<string> =>
  containerArguments({
    ...options,
    limits: options.limits ?? SupervisorLimits.make({}),
    mounts: [
      ...options.sources.map(({ repository, directory }) =>
        bindMount(directory, `${options.paths.workspace}/${repository}`, "readonly"),
      ),
      bindMount(options.relayDirectory, RELAY_DIRECTORY, "readonly"),
    ],
    main: [
      "-e",
      RELAY_SCRIPT,
      String(MODEL_RELAY_PORT),
      `${RELAY_DIRECTORY}/model.sock`,
      String(RELAY_CHECK_INTERVAL_MILLIS),
    ],
  });

/** Runs each command line with this host's shell, which enters the sandbox with `<runtime> exec`. */
const localTransport = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ExecTransport => ({
  run: (line, stdin) =>
    spawner
      .spawn(
        ChildProcess.make("sh", ["-c", line], {
          stdin,
          detached: true,
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(
        Effect.map((handle) => ({
          stdout: handle.stdout.pipe(Stream.orDie),
          stderr: handle.stderr.pipe(Stream.orDie),
          exitCode: handle.exitCode.pipe(Effect.map(Number), Effect.orDie),
        })),
        Effect.orDie,
      ),
});

/** Where the supervisor sandbox keeps conversations, what it runs, and how it reaches the model. */
export interface ContainerSandboxOptions {
  /** The orchestrator directory that holds each conversation's directory. */
  readonly root: string;
  /** The image of each sandbox, with Node.js, a POSIX shell, tar, and the harness CLIs. */
  readonly image: ContainerImage;
  /** Image pulls have no timeout when omitted. */
  readonly imagePullTimeout?: Duration.Duration | undefined;
  readonly limits?: SupervisorLimits;
  /** The container runtime; detected when `None`. */
  readonly runtime: Option.Option<ContainerRuntime>;
  /** The instance's model route, or `None` when the instance has no gateway. */
  readonly route: Option.Option<Effect.Effect<GatewayModelRoute, GatewayModelError>>;
}

/**
 * Returns the first of `providers` that `route`'s gateway holds a credential for, with the turn's
 * credential route, or the first provider with the `gateway` route when it holds none.
 */
const heldProvider = Effect.fn("SupervisorSandbox.heldProvider")(function* (
  route: GatewayModelRoute,
  providers: Arr.NonEmptyReadonlyArray<ModelProvider>,
) {
  for (const provider of providers) {
    const kind = yield* route.credential(provider.slot);
    if (Option.isSome(kind))
      return {
        provider,
        route: kind.value === "subscription" ? "gateway-subscription" : "gateway-api-key",
      } satisfies { readonly provider: ModelProvider; readonly route: CredentialRoute };
  }
  return { provider: providers[0], route: "gateway" } satisfies {
    readonly provider: ModelProvider;
    readonly route: CredentialRoute;
  };
});

const unavailableBecause = (action: string) => (error: { readonly message: string }) =>
  SupervisorUnavailable.make({ message: `Can't ${action}: ${error.message}` });

/** Whether turns can run: the startup check runs `step`, passed, or refused turns for `reason`. */
type Readiness =
  | { readonly _tag: "Preparing"; readonly step: string }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Refused"; readonly reason: SupervisorUnavailable };

const unavailableWhile = (readiness: Readiness): Option.Option<SupervisorUnavailable> => {
  switch (readiness._tag) {
    case "Preparing":
      return Option.some(
        SupervisorUnavailable.make({
          message: `The supervisor isn't ready yet: usine is ${readiness.step}. Retry the turn later.`,
        }),
      );
    case "Ready":
      return Option.none();
    case "Refused":
      return Option.some(readiness.reason);
  }
};

/** A turn whose sandbox runs, and whether a save of its state was tried. */
interface OpenTurn {
  readonly conversation: SandboxRequest["conversation"];
  readonly key: ConversationKey;
  readonly container: SandboxContainer;
  readonly paths: ConversationPaths;
  saveTried: boolean;
}

/**
 * Opens the sandboxes of supervisor turns on `runtime`, with the harness's model requests sent
 * through `openRoute`. Startup removes the containers and FUSE images that earlier processes left,
 * then prepares the image and checks a container in the background; turns wait for that check.
 */
const makeContainerSandbox = Effect.fn("SupervisorSandbox.make")(function* (
  options: Pick<ContainerSandboxOptions, "root" | "image" | "limits" | "imagePullTimeout">,
  runtime: SandboxRuntime,
  openRoute: Effect.Effect<GatewayModelRoute, GatewayModelError>,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const homes = yield* ConversationHomes;
  const transport = localTransport(spawner);
  const limits = options.limits ?? SupervisorLimits.make({});
  const runtimeCommand = (args: ReadonlyArray<string>) =>
    collectCommand(
      spawner,
      "prepare",
      runtime.runtime,
      args,
      { forceKillAfter: "2 seconds" },
      65536,
    ).pipe(Effect.timeout("30 seconds"));

  /** The harness's credential wiring and the providers it can use, if it has wiring. */
  const credentialOf = (harness: Harness) =>
    Option.flatMap(catalog.get(harness), ({ worker, providers }) =>
      Option.flatMap(worker.credential, (credential) =>
        Arr.isReadonlyArrayNonEmpty(providers)
          ? Option.some({ credential, providers })
          : Option.none(),
      ),
    );

  /** The harness's gateway settings for `provider`'s slot, pointed at the relay, for the conversation's home. */
  const wiringOf = (
    harness: Harness,
    credential: HarnessCredential,
    provider: ModelProvider,
    paths: ConversationPaths,
  ) => {
    const rendered = credential.gateway.render(
      `http://127.0.0.1:${MODEL_RELAY_PORT}/${provider.slot}${credential.slotPath}`,
      `${paths.home}/.${harness}`,
    );
    return {
      files: rendered.files,
      environment: { ...rendered.environment, [rendered.tokenVariable]: SANDBOX_TOKEN },
    };
  };

  const serveRelay = Effect.fn("SupervisorSandbox.serveRelay")(function* (
    socket: string,
    route: GatewayModelRoute,
    model: ModelId,
  ) {
    // A model response streams for as long as the turn's longest answer.
    const server = yield* NodeHttpServer.make(modelRelayServer, { path: socket });
    yield* server.serve(relayModelRequest(route, model, limits));
  });

  const startContainer = Effect.fn("SupervisorSandbox.startContainer")(function* (
    name: string,
    args: ReadonlyArray<string>,
  ) {
    const started = yield* runtimeCommand(args).pipe(
      Effect.mapError(unavailableBecause("start the supervisor sandbox")),
    );
    if (started.exitCode !== 0)
      return yield* SupervisorUnavailable.make({
        message: `Can't start the supervisor sandbox: ${started.stderr.trim().split("\n")[0] || `exit code ${started.exitCode}`}`,
      });
    yield* Effect.logInfo("Started a supervisor sandbox", { container: name });
  });

  /** Removes the container `name`, and says whether the runtime removed it. */
  const removeContainer = (name: string): Effect.Effect<boolean> =>
    runtimeCommand(["rm", "--force", name]).pipe(
      Effect.flatMap(({ exitCode, stderr }) =>
        exitCode === 0
          ? Effect.logInfo("Removed a supervisor sandbox", { container: name }).pipe(
              Effect.as(true),
            )
          : Effect.logWarning("Could not remove a supervisor sandbox", {
              container: name,
              exitCode,
              stderr: stderr.trim().split("\n")[0],
            }).pipe(Effect.as(false)),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not remove a supervisor sandbox", {
          container: name,
          message: error.message,
        }).pipe(Effect.as(false)),
      ),
    );

  const awaitRelay = (name: string) =>
    runtimeCommand(["exec", name, "node", "-e", RELAY_PROBE, String(MODEL_RELAY_PORT)]).pipe(
      Effect.filterOrFail(({ exitCode }) => exitCode === 0),
      Effect.tapError(() =>
        Effect.logInfo("Waiting for the supervisor sandbox's model relay to start", {
          container: name,
        }),
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis") }),
      Effect.timeout(RELAY_START_TIMEOUT),
      Effect.mapError(() =>
        SupervisorUnavailable.make({
          message: `The supervisor sandbox's model relay didn't start within ${RELAY_START_TIMEOUT}`,
        }),
      ),
    );

  /** Fails unless the runtime applied the configured CPU, memory, swap and PID limits to `name`. */
  const verifyLimits = Effect.fn("SupervisorSandbox.verifyLimits")(function* (name: string) {
    const enforced = yield* runtimeCommand([
      "exec",
      name,
      "sh",
      "-ec",
      CONTAINER_LIMITS_SCRIPT,
      "sh",
      String(limits.cpus),
      String(limits.memoryMib * 1024 ** 2),
      String(limits.pids),
    ]).pipe(Effect.mapError(unavailableBecause("verify supervisor resource limits")));
    if (enforced.exitCode === 0) return;
    yield* Effect.logWarning("The supervisor runtime did not enforce resource limits", {
      container: name,
      runtime: runtime.runtime,
    });
    return yield* SupervisorUnavailable.make({
      message:
        "The runtime did not enforce supervisor CPU, memory, zero-swap and PID limits; check cgroup v2 delegation",
    });
  });

  const listContainers = (conversation?: string) =>
    runtimeCommand([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${ROOT_LABEL}=${options.root}`,
      ...(conversation === undefined
        ? []
        : ["--filter", `label=${CONVERSATION_LABEL}=${conversation}`]),
    ]).pipe(
      Effect.flatMap(({ exitCode, stdout }) =>
        exitCode === 0
          ? Effect.succeed(
              stdout
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            )
          : Effect.fail(
              SupervisorUnavailable.make({ message: "Cannot list supervisor containers" }),
            ),
      ),
      Effect.mapError(unavailableBecause("list supervisor containers")),
    );
  const removeLabeled = Effect.fn("SupervisorSandbox.removeLabeled")(function* (
    conversation?: string,
  ) {
    const containers = yield* listContainers(conversation);
    yield* Effect.forEach(containers, removeContainer, { discard: true });
    return (yield* listContainers(conversation)).length === 0;
  });
  const cleanup = (conversation?: string) =>
    removeLabeled(conversation).pipe(
      Effect.catch((error) =>
        Effect.logError("Could not remove labeled supervisor containers", {
          conversation,
          message: error.message,
        }).pipe(Effect.as(false)),
      ),
    );
  yield* Effect.addFinalizer(() => cleanup().pipe(Effect.asVoid));
  if (!(yield* cleanup())) {
    yield* Effect.logWarning(
      "Supervisor startup refused: containers from an earlier process remain",
      { root: options.root },
    );
    return yield* SupervisorUnavailable.make({
      message: "Supervisor containers from an earlier process remain; refusing new turns",
    });
  }
  yield* removeFuseStorage(options.root).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not look for supervisor storage from an earlier version", {
        root: options.root,
        message: error.message,
      }),
    ),
  );

  /**
   * Starts a container with a turn's limits and in-memory home, and copies a home into it and back
   * out, so that a host problem fails this check and not a member's turn.
   */
  const checkContainer = Effect.fn("SupervisorSandbox.checkContainer")(
    function* () {
      const paths = conversationPaths(`${options.root}/startup-check`);
      yield* confinedDirectory(fs, options.root, paths.workspace);
      const suffix = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16);
      const container = { runtime: runtime.runtime, name: `usine-supervisor-check-${suffix}` };
      yield* Effect.addFinalizer(() => cleanup(CHECK_CONVERSATION).pipe(Effect.asVoid));
      yield* startContainer(
        container.name,
        containerArguments({
          name: container.name,
          root: options.root,
          conversation: CHECK_CONVERSATION,
          runtime,
          image: options.image,
          paths,
          limits,
          mounts: [],
          main: ["-e", IDLE_SCRIPT],
        }),
      );
      yield* verifyLimits(container.name);
      yield* restoreHome(spawner, container, paths.root, Option.none(), [
        [`${paths.home}/check`, "usine startup check\n"],
      ]);
      const archived = yield* Stream.runCollect(
        archiveHome(spawner, container, paths.root, limits.conversationSizeMib),
      );
      yield* restoreHome(
        spawner,
        container,
        paths.root,
        Option.some(Stream.fromIterable(archived)),
        [],
      );
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: CHECK_TIMEOUT,
      orElse: () =>
        Effect.fail(
          SupervisorUnavailable.make({
            message: `the check didn't finish within ${CHECK_TIMEOUT}`,
          }),
        ),
    }),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const rootlessPodman = runtime.runtime === "podman" && runtime.rootless;
        return yield* SupervisorUnavailable.make({
          message:
            rootlessPodman && (yield* noNewPrivileges)
              ? `Supervisor sessions run in a container, and ${ROOTLESS_PODMAN_REFUSAL}. The startup check failed: ${error.message}`
              : `The supervisor's startup check failed: ${error.message}`,
        });
      }),
    ),
  );

  const readiness = yield* SubscriptionRef.make<Readiness>({
    _tag: "Preparing",
    step: "preparing the supervisor image",
  });
  yield* Effect.gen(function* () {
    yield* prepareImage(
      spawner,
      runtime.runtime,
      options.image,
      Option.fromUndefinedOr(options.imagePullTimeout),
    ).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Supervisor image preparation failed; retrying in one minute", {
          image: options.image,
          message: error.message,
        }).pipe(
          Effect.andThen(
            SubscriptionRef.set(readiness, {
              _tag: "Preparing",
              step: `preparing the supervisor image, which failed and is retried every minute (${error.message})`,
            }),
          ),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("1 minute") }),
    );
    yield* SubscriptionRef.set(readiness, {
      _tag: "Preparing",
      step: "checking a test container",
    });
    const checked = yield* checkContainer().pipe(Effect.result);
    if (Result.isFailure(checked)) {
      yield* Effect.logWarning(
        "The supervisor's startup check failed; fix the cause and restart usine",
        { runtime: runtime.runtime, message: checked.failure.message },
      );
      return yield* SubscriptionRef.set(readiness, { _tag: "Refused", reason: checked.failure });
    }
    yield* Effect.logInfo("The supervisor's startup check passed", { runtime: runtime.runtime });
    yield* SubscriptionRef.set(readiness, { _tag: "Ready" });
  }).pipe(Effect.forkScoped);

  const unavailable = SubscriptionRef.get(readiness).pipe(Effect.map(unavailableWhile));
  const checked = SubscriptionRef.changes(readiness).pipe(
    Stream.filter((state) => state._tag !== "Preparing"),
    Stream.runHead,
    Effect.andThen(unavailable),
  );

  const running = new Map<string, "active" | "cleanup failed">();
  const holdConversation = (conversation: string, directory: string) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        if (running.get(directory) === "active") {
          yield* Effect.logWarning("Another turn of this supervisor conversation is running", {
            conversation,
            directory,
          });
          return yield* SupervisorUnavailable.make({
            message: "Another turn of this supervisor conversation is running",
          });
        }
        running.set(directory, "active");
      }),
      () =>
        cleanup(conversation).pipe(
          Effect.flatMap((removed) => {
            if (removed) running.delete(directory);
            else running.set(directory, "cleanup failed");
            return removed
              ? Effect.logInfo("Released a supervisor conversation", {
                  conversation,
                  directory,
                  container: "removed",
                })
              : Effect.logError("Kept the hold on a supervisor conversation: containers remain", {
                  conversation,
                  directory,
                });
          }),
        ),
    );

  /** The turns whose sandboxes run, by container name. */
  const turns = new Map<string, OpenTurn>();

  /**
   * Saves the home of `turn` from its sandbox, then checks the files that the orchestrator's own
   * harness process wrote for the conversation.
   */
  const saveTurn = Effect.fn("SupervisorSandbox.save")(function* (turn: OpenTurn) {
    yield* Effect.annotateCurrentSpan({
      conversation: turn.conversation,
      container: turn.container.name,
    });
    turn.saveTried = true;
    yield* homes
      .save(
        turn.key,
        archiveHome(spawner, turn.container, turn.paths.root, limits.conversationSizeMib),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "HomeStoreError"
            ? SupervisorUnavailable.make({
                message: `Can't save the conversation's home: ${error.message}`,
              })
            : error,
        ),
        Effect.timeoutOrElse({
          duration: SAVE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              SupervisorUnavailable.make({
                message: `Can't save the conversation's home: the copy didn't finish within ${SAVE_TIMEOUT}`,
              }),
            ),
        }),
      );
    yield* checkWorkspaceSize(fs, turn.paths.workspace, limits);
    yield* Effect.logInfo("Saved a supervisor conversation", {
      conversation: turn.conversation,
      container: turn.container.name,
    });
  });

  const save = (seat: SupervisorSeat) =>
    Option.match(Option.fromUndefinedOr(turns.get(seat.host.container.name)), {
      onNone: () =>
        Effect.fail(
          SupervisorUnavailable.make({
            message: "Can't save the conversation: its turn's sandbox is closed",
          }),
        ),
      onSome: saveTurn,
    });

  const open = Effect.fn("SupervisorSandbox.open")(function* (request: SandboxRequest) {
    yield* Effect.annotateCurrentSpan({
      conversation: request.conversation,
      harness: request.harness,
      sources: request.sources.length,
    });
    const notReady = yield* checked.pipe(
      Effect.timeoutOrElse({ duration: READY_TIMEOUT, orElse: () => unavailable }),
    );
    if (Option.isSome(notReady)) {
      yield* Effect.logWarning("Supervisor turn refused: the sandbox isn't ready", {
        conversation: request.conversation,
        reason: notReady.value.message,
      });
      return yield* notReady.value;
    }
    const key = conversationKey(request.conversation);
    const paths = conversationPaths(`${options.root}/conversations/${key}`);
    // No sandbox of the conversation writes to its directory while this turn prepares it.
    yield* holdConversation(request.conversation, paths.root);
    if ((yield* listContainers(request.conversation)).length !== 0) {
      yield* Effect.logWarning("A supervisor container remains; refusing a new turn", {
        conversation: request.conversation,
      });
      return yield* SupervisorUnavailable.make({
        message: "A supervisor container remains for this conversation; refusing a new turn",
      });
    }
    // The workspace, and the mount points of the sources in it, exist before they're mounted, even
    // for a turn without sources: Podman refuses a missing mount source, and Docker creates it as
    // its daemon's user. A runtime follows links in a mount source, so none is followed here.
    yield* Effect.forEach(
      [
        paths.workspace,
        ...request.sources.map(({ repository }) => `${paths.workspace}/${repository}`),
      ],
      (directory) => confinedDirectory(fs, options.root, directory),
      { discard: true },
    );
    const written = yield* checkWorkspaceSize(fs, paths.workspace, limits);
    const route = yield* openRoute.pipe(
      Effect.mapError(unavailableBecause("open the instance's model route")),
    );
    const wired = yield* Option.match(credentialOf(request.harness), {
      onNone: () => Effect.succeedNone,
      onSome: ({ credential: harnessCredential, providers }) =>
        Effect.map(heldProvider(route, providers), ({ provider, route: held }) =>
          Option.some({
            route: held,
            wiring: wiringOf(request.harness, harnessCredential, provider, paths),
          }),
        ),
    }).pipe(Effect.mapError(unavailableBecause("check the instance's model credential")));
    const credential: CredentialRoute = Option.match(wired, {
      onNone: () => "gateway",
      onSome: ({ route: held }) => held,
    });
    const wiring = Option.map(wired, ({ wiring: rendered }) => rendered);
    // A socket path has a short length limit, so the relay's directory is in the system's.
    const relayDirectory = yield* fs
      .makeTempDirectoryScoped({ prefix: "usine-supervisor-" })
      .pipe(Effect.mapError(unavailableBecause("create the model relay's directory")));
    yield* serveRelay(`${relayDirectory}/model.sock`, route, request.model).pipe(
      Effect.mapError(unavailableBecause("serve the model relay")),
    );
    const suffix = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16);
    const container = {
      runtime: runtime.runtime,
      name: `usine-supervisor-${key.slice(0, 40)}-${suffix}`,
    };
    yield* Effect.addFinalizer(() => cleanup(request.conversation).pipe(Effect.asVoid));
    yield* startContainer(
      container.name,
      sandboxRunArguments({
        name: container.name,
        root: options.root,
        conversation: request.conversation,
        runtime,
        image: options.image,
        paths,
        sources: request.sources,
        relayDirectory,
        limits,
      }),
    );
    yield* awaitRelay(container.name);
    yield* verifyLimits(container.name);
    const saved = yield* homes
      .load(key)
      .pipe(Effect.mapError(unavailableBecause("read the conversation's saved home")));
    yield* restoreHome(
      spawner,
      container,
      paths.root,
      saved,
      Option.match(wiring, { onNone: () => [], onSome: ({ files }) => files }),
    );
    const turn: OpenTurn = {
      conversation: request.conversation,
      key,
      container,
      paths,
      saveTried: false,
    };
    turns.set(container.name, turn);
    // Runs before the container's removal, which the finalizers added earlier do.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        turns.delete(container.name);
        if (turn.saveTried) return;
        yield* saveTurn(turn).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not save a supervisor conversation at the end of its turn", {
              conversation: request.conversation,
              message: error.message,
            }),
          ),
        );
      }),
    );
    return SupervisorSeat.make({
      host: yield* Schema.decodeEffect(SupervisorSeat.fields.host)(
        ExecShell.make({ transport, destination: container.name, container }),
      ).pipe(Effect.mapError(unavailableBecause("construct the supervisor seat"))),
      worker: WorkerName.make("supervisor"),
      protocolFrameMib: limits.protocolFrameMib,
      cwd: WorkingDirectory.make(paths.workspace),
      environment: Option.match(wiring, {
        onNone: () => ({}),
        onSome: ({ environment }) => environment,
      }),
      credential,
      restored: Option.isSome(saved) || written > 0,
    });
  });

  return { unavailable, checked, open, save } satisfies SupervisorSandboxService;
});

/** A sandbox on which every turn fails with `reason`. */
const refusing = (reason: SupervisorUnavailable): SupervisorSandboxService => ({
  unavailable: Effect.succeedSome(reason),
  checked: Effect.succeedSome(reason),
  open: () => Effect.fail(reason),
  save: () => Effect.fail(reason),
});

/**
 * The supervisor sandbox as one container per turn, on Podman or Docker on the orchestrator host.
 * The container has no network: a relay inside it forwards the harness's model requests over a
 * socket to the orchestrator, which sends them through the instance's model route with the
 * instance's credential. Each repository's source is mounted read-only under the working
 * directory. The harness's home is an in-memory filesystem of `conversation_size_mib`, which each
 * turn restores from `ConversationHomes` and saves back when it ends; no instance file is
 * mounted. Without a container runtime, a model route, or limits that leave the harness memory,
 * every turn fails with the reason.
 */
export const containerSandboxLayer = (options: ContainerSandboxOptions) =>
  Layer.effect(
    SupervisorSandbox,
    Effect.gen(function* () {
      const limits = options.limits ?? SupervisorLimits.make({});
      const detected = yield* detectSandboxRuntime(options.runtime);
      const available = Result.flatMap(detected, (runtime) =>
        Option.match(options.route, {
          onNone: () =>
            Result.fail(
              SupervisorUnavailable.make({
                message:
                  "Supervisor sessions reach the model through the instance's gateway, and no worker gateway is configured",
              }),
            ),
          onSome: (route) =>
            Option.match(memoryShortfall(limits), {
              onNone: () => Result.succeed({ runtime, route }),
              onSome: (message) => Result.fail(SupervisorUnavailable.make({ message })),
            }),
        }),
      );
      if (Result.isFailure(available)) {
        const reason = available.failure;
        yield* Effect.logInfo("Supervisor sessions are unavailable on this orchestrator", {
          reason: reason.message,
        });
        return refusing(reason);
      }
      const { runtime, route } = available.success;
      const prepared = yield* makeContainerSandbox(options, runtime, route).pipe(Effect.result);
      if (Result.isFailure(prepared)) {
        yield* Effect.logWarning("Supervisor sandbox preparation failed", {
          message: prepared.failure.message,
        });
        return refusing(prepared.failure);
      }
      return prepared.success;
    }),
  );
