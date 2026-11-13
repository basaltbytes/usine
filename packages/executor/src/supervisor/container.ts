// The model relay serves HTTP on a Unix socket, which needs Node's server.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { ExecShell, type ExecTransport } from "@usine/agents/child-host";
import { catalog, type CredentialRoute } from "@usine/agents/harness";
import { WorkingDirectory } from "@usine/agents/runtime";
import {
  type SandboxRequest,
  SupervisorSandbox,
  type SupervisorSandboxService,
  SupervisorSeat,
  SupervisorUnavailable,
} from "@usine/agents/supervisor";
import type { Harness } from "@usine/core/agent/brain";
import { safeSegment } from "@usine/core/repository";
import { type ContainerImage, WorkerName } from "@usine/core/worker";
import { Cause, Effect, FileSystem, Layer, Option, Random, Result, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { collectCommand } from "../child-command.ts";
import { type ContainerRuntime, runtimeOptions } from "../remote/runtime.ts";
import type { GatewayModelError, GatewayModelRoute } from "../ssh/gateway/model-route.ts";
import { relayModelRequest } from "./model-relay.ts";

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
 * socket, which the orchestrator serves. The container has no other network. It exits once the
 * socket refuses a connection, as after the orchestrator stops, which stops and removes the
 * container with every process in it.
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

/** How long the runtime has to answer at startup, so that a hung daemon doesn't hold the orchestrator. */
const DETECTION_TIMEOUT = "15 seconds";

/** How long a new sandbox's model relay has to accept connections. */
const RELAY_START_TIMEOUT = "30 seconds";

/** The label whose value is the sandbox root of the orchestrator that started the container. */
const ROOT_LABEL = "usine.supervisor.root";

/** The label whose value is the conversation that the container runs a turn of. */
const CONVERSATION_LABEL = "usine.supervisor.conversation";

/** The container runtime that runs supervisor sandboxes, and whether it runs without root. */
export interface SandboxRuntime {
  readonly runtime: ContainerRuntime;
  readonly rootless: boolean;
}

/** The output format of `<runtime> info` that says whether the runtime runs without root. */
const rootlessFormat = {
  podman: "{{.Host.Security.Rootless}}",
  docker: "{{json .SecurityOptions}}",
} satisfies Record<ContainerRuntime, string>;

/**
 * Finds the container runtime for supervisor sandboxes: `preferred`, or Podman and then Docker.
 * Returns why there is none when no candidate is installed or can run containers.
 */
export const detectSandboxRuntime = Effect.fn("SupervisorSandbox.detectRuntime")(function* (
  preferred: Option.Option<ContainerRuntime>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const candidates = Option.match(preferred, {
    onNone: () => ["podman", "docker"] as const,
    onSome: (runtime) => [runtime] as const,
  });
  const problems: Array<string> = [];
  for (const runtime of candidates) {
    const info = yield* collectCommand(
      spawner,
      "preflight",
      runtime,
      ["info", "--format", rootlessFormat[runtime]],
      {},
    ).pipe(Effect.timeout(DETECTION_TIMEOUT), Effect.result);
    if (Result.isFailure(info)) {
      if (Cause.isTimeoutError(info.failure)) {
        problems.push(`${runtime} didn't answer within ${DETECTION_TIMEOUT}`);
        yield* Effect.logInfo("Skipped a container runtime that didn't answer", {
          runtime,
          timeout: DETECTION_TIMEOUT,
        });
        continue;
      }
      yield* Effect.logInfo("Skipped a container runtime that isn't installed", {
        runtime,
        message: info.failure.message,
      });
      continue;
    }
    if (info.success.exitCode !== 0) {
      const reason = info.success.stderr.trim().split("\n")[0] ?? "";
      problems.push(
        `${runtime} is installed but can't run containers${reason === "" ? "" : `: ${reason}`}`,
      );
      yield* Effect.logInfo("Skipped a container runtime that can't run containers", {
        runtime,
        exitCode: info.success.exitCode,
        reason,
      });
      continue;
    }
    const output = info.success.stdout.trim();
    const rootless = runtime === "podman" ? output === "true" : output.includes("rootless");
    yield* Effect.logInfo("Found the container runtime for supervisor sandboxes", {
      runtime,
      rootless,
    });
    return Result.succeed<SandboxRuntime>({ runtime, rootless });
  }
  const names = candidates.map((runtime) => (runtime === "podman" ? "Podman" : "Docker"));
  return Result.fail(
    SupervisorUnavailable.make({
      message:
        problems.length > 0
          ? `Supervisor sessions run in a container, and ${problems.join("; ")}`
          : `Supervisor sessions run in a container, and ${names.join(" or ")} isn't installed on the orchestrator host`,
    }),
  );
});

/** The user that the container's processes run as, so that files they write belong to this host user. */
const userOptions = ({ runtime, rootless }: SandboxRuntime): ReadonlyArray<string> => {
  const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  if (runtime === "podman") return [...runtimeOptions(runtime), "--user", owner];
  // Root in a rootless Docker container is the host user.
  return rootless ? ["--user", "0:0", "--env", "IS_SANDBOX=1"] : ["--user", owner];
};

/** The directories of one conversation on the orchestrator, at the same paths in its sandbox. */
interface ConversationPaths {
  /** Read-write: holds `home` and the PID files of the session's processes. */
  readonly root: string;
  /** Read-write: the harness's home directory, with its saved sessions. */
  readonly home: string;
  /** Read-only: the session's working directory, with one source directory per repository. */
  readonly workspace: string;
}

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
}): ReadonlyArray<string> => {
  const { paths } = options;
  return [
    "run",
    "--detach",
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
    "/tmp:rw,nosuid,nodev",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...userOptions(options.runtime),
    "--env",
    `HOME=${paths.home}`,
    "--workdir",
    paths.workspace,
    "--volume",
    `${paths.root}:${paths.root}:rw`,
    "--volume",
    `${paths.workspace}:${paths.workspace}:ro`,
    ...options.sources.flatMap(({ repository, directory }) => [
      "--volume",
      `${directory}:${paths.workspace}/${repository}:ro`,
    ]),
    "--volume",
    `${options.relayDirectory}:${RELAY_DIRECTORY}:ro`,
    "--entrypoint",
    "node",
    options.image,
    "-e",
    RELAY_SCRIPT,
    String(MODEL_RELAY_PORT),
    `${RELAY_DIRECTORY}/model.sock`,
    String(RELAY_CHECK_INTERVAL_MILLIS),
  ];
};

/** Runs each command line with this host's shell, which enters the sandbox with `<runtime> exec`. */
const localTransport = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ExecTransport => ({
  run: (line, stdin) =>
    spawner.spawn(ChildProcess.make("sh", ["-c", line], { stdin, detached: true })).pipe(
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
  /** The image of each sandbox, with Node.js, a POSIX shell, and the harness CLIs. */
  readonly image: ContainerImage;
  /** The container runtime; detected when `None`. */
  readonly runtime: Option.Option<ContainerRuntime>;
  /** The instance's model route, or `None` when the instance has no gateway. */
  readonly route: Option.Option<Effect.Effect<GatewayModelRoute, GatewayModelError>>;
}

/** The credential route of a turn whose harness reaches the model through `route`'s `protocol`. */
const credentialRoute = (
  route: GatewayModelRoute,
  protocol: Parameters<GatewayModelRoute["credential"]>[0],
) =>
  route.credential(protocol).pipe(
    Effect.map(
      Option.match({
        onNone: (): CredentialRoute => "gateway",
        onSome: (kind): CredentialRoute =>
          kind === "subscription" ? "gateway-subscription" : "gateway-api-key",
      }),
    ),
  );

const unavailableBecause = (action: string) => (error: { readonly message: string }) =>
  SupervisorUnavailable.make({ message: `Can't ${action}: ${error.message}` });

/**
 * Opens the sandboxes of supervisor turns on `runtime`, with the harness's model requests sent
 * through `openRoute`.
 */
const makeContainerSandbox = Effect.fn("SupervisorSandbox.make")(function* (
  options: Pick<ContainerSandboxOptions, "root" | "image">,
  runtime: SandboxRuntime,
  openRoute: Effect.Effect<GatewayModelRoute, GatewayModelError>,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const transport = localTransport(spawner);
  const runtimeCommand = (args: ReadonlyArray<string>) =>
    collectCommand(spawner, "prepare", runtime.runtime, args, {});

  /** Whether `path` exists as a directory, without following a symbolic link at `path`. */
  const realDirectory = Effect.fn("SupervisorSandbox.realDirectory")(function* (path: string) {
    const info = yield* fs.lstat(path).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
    );
    if (Option.isSome(info) && info.value.type === "Directory") return;
    if (Option.isSome(info)) {
      yield* Effect.logWarning("Replaced a file in a supervisor conversation with a directory", {
        path,
        type: info.value.type,
      });
      yield* fs.remove(path);
    }
    yield* fs.makeDirectory(path);
  });

  /**
   * Makes each directory from `root` down to `path` a real directory, replacing a symbolic link or
   * other file in its place. A sandbox can write under `root`, so nothing there is followed.
   */
  const confinedDirectory = Effect.fn("SupervisorSandbox.confinedDirectory")(function* (
    root: string,
    path: string,
  ) {
    let current = root;
    for (const segment of path.slice(root.length + 1).split("/")) {
      current = `${current}/${segment}`;
      yield* realDirectory(current);
    }
  });

  /**
   * Writes `contents` to `path` under `root` without following a symbolic link: to a new file
   * beside it, which then replaces whatever `path` is.
   */
  const writeConfinedFile = Effect.fn("SupervisorSandbox.writeConfinedFile")(function* (
    root: string,
    path: string,
    contents: string,
  ) {
    const directory = path.slice(0, path.lastIndexOf("/"));
    yield* confinedDirectory(root, directory);
    const existing = yield* fs.lstat(path).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
    );
    if (Option.isSome(existing) && existing.value.type === "Directory")
      yield* fs.remove(path, { recursive: true });
    const suffix = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16);
    const staged = `${path}.usine-${suffix}`;
    // `wx` creates the file and fails on any existing entry, including a symbolic link.
    yield* fs.writeFileString(staged, contents, { flag: "wx" });
    yield* fs.rename(staged, path);
  });

  /** Writes the harness's gateway settings, pointed at the relay, into the conversation's home. */
  const writeWiring = Effect.fn("SupervisorSandbox.writeWiring")(function* (
    harness: Harness,
    paths: ConversationPaths,
  ) {
    const credential = Option.flatMap(catalog.get(harness), ({ worker }) => worker.credential);
    if (Option.isNone(credential)) return Option.none();
    const { protocol, gatewayPath, gateway } = credential.value;
    const rendered = gateway.render(
      `http://127.0.0.1:${MODEL_RELAY_PORT}/${gatewayPath}`,
      `${paths.home}/.${harness}`,
    );
    for (const [path, contents] of rendered.files)
      yield* writeConfinedFile(paths.root, path, contents);
    return Option.some({
      protocol,
      environment: { ...rendered.environment, [rendered.tokenVariable]: SANDBOX_TOKEN },
    });
  });

  const serveRelay = Effect.fn("SupervisorSandbox.serveRelay")(function* (
    socket: string,
    route: GatewayModelRoute,
  ) {
    // A model response streams for as long as the turn's longest answer.
    const server = yield* NodeHttpServer.make(() => createServer({ requestTimeout: 0 }), {
      path: socket,
    });
    yield* server.serve(relayModelRequest(route));
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

  const removeContainer = (name: string) =>
    runtimeCommand(["rm", "--force", name]).pipe(
      Effect.flatMap(({ exitCode, stderr }) =>
        exitCode === 0
          ? Effect.logInfo("Removed a supervisor sandbox", { container: name })
          : Effect.logWarning("Could not remove a supervisor sandbox", {
              container: name,
              exitCode,
              stderr: stderr.trim().split("\n")[0],
            }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not remove a supervisor sandbox", {
          container: name,
          message: error.message,
        }),
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

  /** Removes the sandboxes that an earlier orchestrator process on this root left running. */
  const removeLeftovers = Effect.fn("SupervisorSandbox.removeLeftovers")(function* () {
    const listed = yield* runtimeCommand([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${ROOT_LABEL}=${options.root}`,
    ]);
    if (listed.exitCode !== 0) {
      yield* Effect.logWarning(
        "Could not list the supervisor sandboxes that an earlier process left",
        {
          exitCode: listed.exitCode,
          stderr: listed.stderr.trim().split("\n")[0],
        },
      );
      return;
    }
    const left = listed.stdout.split("\n").filter((line) => line.trim() !== "");
    if (left.length === 0) {
      yield* Effect.logInfo("No supervisor sandbox was left by an earlier process");
      return;
    }
    yield* Effect.logInfo("Removing the supervisor sandboxes that an earlier process left", {
      containers: left.length,
    });
    yield* Effect.forEach(left, (container) => removeContainer(container.trim()), {
      discard: true,
    });
  });
  yield* removeLeftovers().pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not list the supervisor sandboxes that an earlier process left", {
        message: error.message,
      }),
    ),
  );

  /** The conversations whose turn has a sandbox open in this process. */
  const running = new Set<string>();
  /** Holds `conversation` for the scope, or fails if another turn of it holds it. */
  const holdConversation = (conversation: string) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        if (running.has(conversation))
          return Effect.logWarning(
            "Refused a supervisor turn: another turn of the conversation is running",
            {
              conversation,
            },
          ).pipe(
            Effect.andThen(
              Effect.fail(
                SupervisorUnavailable.make({
                  message: "Another turn of this supervisor conversation is running",
                }),
              ),
            ),
          );
        running.add(conversation);
        return Effect.void;
      }),
      () => Effect.sync(() => running.delete(conversation)),
    );

  return Effect.fn("SupervisorSandbox.open")(function* (request: SandboxRequest) {
    yield* Effect.annotateCurrentSpan({
      conversation: request.conversation,
      harness: request.harness,
      sources: request.sources.length,
    });
    // No sandbox of the conversation writes to its directory while this turn prepares it.
    yield* holdConversation(request.conversation);
    const root = `${options.root}/conversations/${safeSegment(request.conversation)}`;
    const paths: ConversationPaths = { root, home: `${root}/home`, workspace: `${root}/workspace` };
    // The mount points of the sources exist before the read-only workspace is mounted.
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(
        Effect.andThen(
          Effect.forEach(
            [
              paths.home,
              ...request.sources.map(({ repository }) => `${paths.workspace}/${repository}`),
            ],
            (directory) => confinedDirectory(root, directory),
            { discard: true },
          ),
        ),
        Effect.mapError(unavailableBecause("create the conversation's directories")),
      );
    const wiring = yield* writeWiring(request.harness, paths).pipe(
      Effect.mapError(unavailableBecause("write the harness's model settings")),
    );
    const route = yield* openRoute.pipe(
      Effect.mapError(unavailableBecause("open the instance's model route")),
    );
    const credential = yield* Option.match(wiring, {
      onNone: () => Effect.succeed<CredentialRoute>("gateway"),
      onSome: ({ protocol }) => credentialRoute(route, protocol),
    }).pipe(Effect.mapError(unavailableBecause("check the instance's model credential")));
    // A socket path has a short length limit, so the relay's directory is in the system's.
    const relayDirectory = yield* fs
      .makeTempDirectoryScoped({ prefix: "usine-supervisor-" })
      .pipe(Effect.mapError(unavailableBecause("create the model relay's directory")));
    yield* serveRelay(`${relayDirectory}/model.sock`, route).pipe(
      Effect.mapError(unavailableBecause("serve the model relay")),
    );
    const suffix = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16);
    const name = `usine-supervisor-${safeSegment(request.conversation).slice(0, 40)}-${suffix}`;
    yield* Effect.acquireRelease(
      startContainer(
        name,
        sandboxRunArguments({
          name,
          root: options.root,
          conversation: request.conversation,
          runtime,
          image: options.image,
          paths,
          sources: request.sources,
          relayDirectory,
        }),
      ),
      () => removeContainer(name),
    );
    yield* awaitRelay(name);
    return SupervisorSeat.make({
      host: ExecShell.make({
        transport,
        destination: name,
        container: { runtime: runtime.runtime, name },
      }),
      worker: WorkerName.make("supervisor"),
      cwd: WorkingDirectory.make(paths.workspace),
      environment: Option.match(wiring, {
        onNone: () => ({}),
        onSome: ({ environment }) => environment,
      }),
      credential,
    });
  });
});

/**
 * The supervisor sandbox as one container per turn, on Podman or Docker on the orchestrator host.
 * The container has no network: a relay inside it forwards the harness's model requests over a
 * socket to the orchestrator, which sends them through the instance's model route with the
 * instance's credential. Each repository's source is mounted read-only under the working
 * directory, and only the conversation's own directory is writable; no instance file is mounted.
 * The conversation's directory, with the harness's saved sessions, stays after the turn. Without
 * a container runtime or a model route, every turn fails with the reason.
 */
export const containerSandboxLayer = (options: ContainerSandboxOptions) =>
  Layer.effect(
    SupervisorSandbox,
    Effect.gen(function* () {
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
          onSome: (route) => Result.succeed({ runtime, route }),
        }),
      );
      if (Result.isFailure(available)) {
        const reason = available.failure;
        yield* Effect.logInfo("Supervisor sessions are unavailable on this orchestrator", {
          reason: reason.message,
        });
        return {
          unavailable: Option.some(reason),
          open: () => Effect.fail(reason),
        } satisfies SupervisorSandboxService;
      }
      const { runtime, route } = available.success;
      const open = yield* makeContainerSandbox(options, runtime, route);
      return { unavailable: Option.none(), open } satisfies SupervisorSandboxService;
    }),
  );
