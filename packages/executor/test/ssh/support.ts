import { harnessesLive } from "@usine/agents/harness/node";
import { jsonKey } from "@usine/core/json-key";
import { NodeCrypto } from "@effect/platform-node";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  CHILD_KILL_SCRIPT,
  type ChildHost,
  RemoteShell,
  STDIN_ENVIRONMENT_PREFIX,
} from "@usine/agents/child-host";
import { CODEX_CLI_VERSION } from "@usine/agents/preflight";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptTask, AttemptId, AttemptWindow, AttemptWindows } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import { InstanceId } from "@usine/core/instance";
import { SalvageRef } from "@usine/core/attempt/salvage";
import { LoopName, type LoopPermissions } from "@usine/core/loop";
import { RepositoryName, CommitSha, RepositoryRevision } from "@usine/core/repository";
import {
  BotAccount,
  BotLogin,
  BotUserId,
  ContainerCpus,
  ContainerMemoryMib,
  ContainerPids,
  SshDestination,
  SshIdentityFile,
  SshPort,
  WorkerName,
  WorkerRoot,
} from "@usine/core/worker";
import {
  completes,
  type StubParent,
  stubAttemptRuntime,
  StubStorage,
} from "@usine/durable/testing";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  PlatformError,
  Redacted,
  Sink,
  Stream,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
// The synchronous SSH fake runs the actual disk probe with stub shell commands.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";

import {
  CheckoutRequest,
  hostLoginLockLayer,
  CredentialProvider,
  WorkerCredential,
} from "../../src/executor.ts";
import {
  layer as sshLayer,
  type SshExecutorOptions,
  type SshWorkerAddress,
} from "../../src/ssh/ssh.ts";
import { claudeVersionOutput } from "../claude-code.ts";

const ATTEMPT_ID = AttemptId.make("remote-run/execute/1");

/**
 * Returns the windows of `attemptId` alone on its Run's Item: its own window, open since before
 * any test time, and no other Attempt of its Agent, so the harvest keeps every signed comment.
 */
export const aloneOnItem = (attemptId: AttemptId = ATTEMPT_ID) =>
  Effect.succeed(
    AttemptWindows.make({
      own: Option.some(
        AttemptWindow.make({
          attemptId,
          startedAt: DateTime.makeUnsafe(0),
          endedAt: Option.none(),
        }),
      ),
      overlapping: [],
    }),
  );
export const WORKER = WorkerName.make("eu-one");
export const DESTINATION = SshDestination.make("usine@203.0.113.7");
const REPOSITORY = RepositoryName.make("acme/demo");
const COMMIT = CommitSha.make("0123456789abcdef0123456789abcdef01234567");
const SALVAGE_COMMIT = CommitSha.make("fedcba9876543210fedcba9876543210fedcba98");
export const WORKER_ROOT = "/srv/usine/workers/eu-one";
export const WORKTREE = `${WORKER_ROOT}/attempts/remote-run_execute_1`;
export const CREDENTIALS = `${WORKER_ROOT}/credentials/remote-run_execute_1`;
/** The checkout's git directory inside the cached clone. */
export const GIT_DIRECTORY = `${WORKER_ROOT}/repos/acme_demo.git/worktrees/remote-run_execute_1`;
/** The prefix of every token the fake provider mints, so a substring search finds leaks. */
export const TOKEN_PREFIX = "ghs_ssh-worker-test-token-";
export const TEST_AGENT = Agent.make({
  name: AgentName.make("developer"),
  brain: BrainSpec.make({
    harness: Harness.make("claude"),
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the task."),
});

const NUL = String.fromCharCode(0);
/** The temporary directory the fake local file system creates. */
export const LOCAL_TEMPORARY_DIRECTORY = "/tmp/usine-known-hosts-test";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface RemoteCall {
  readonly command: ChildProcess.StandardCommand;
  readonly line: string;
  readonly input: string;
  /** The variables that the command read from its stdin environment block, by name. */
  readonly stdinEnvironment: Readonly<Record<string, string>>;
  /** The container that ran the command, if it ran through `docker exec`. */
  readonly container?: string;
}

/** A container on the fake machine. */
interface FakeContainer {
  /** The ID that its `docker run` printed. */
  readonly id: string;
  /** The arguments of its `docker run`. */
  readonly args: ReadonlyArray<string>;
  readonly labels: ReadonlyMap<string, string>;
  /** The `--env-file` content read from standard input. */
  readonly environment: string;
  /** Whether its init runs. */
  running: boolean;
  /** Whether the kernel killed its init for memory, if it stopped. */
  initKilledForMemory: boolean;
  /** The processes that the kernel killed for memory since it started, which `memory.events` counts. */
  oomKills: number;
}

/** A fake SSH client that forwards a local port to a Gateway's admin API. */
interface FakeForward {
  readonly command: ChildProcess.StandardCommand;
  readonly port: number;
  /** Whether the client is running. */
  live: boolean;
  /** Whether requests through the client are delivered to the admin API. If false, the connection is dead but the client hasn't detected it. */
  carries: boolean;
  /** Ends the client like a dropped connection. */
  readonly drop: Effect.Effect<void>;
}

interface FakeMachineState {
  outputCollection: string;
  readonly calls: Array<RemoteCall>;
  /** The token in each credential directory on the machine, by path. */
  readonly credentials: Map<string, string>;
  reachable: boolean;
  /** The commands refused because the machine wasn't reachable. */
  refusedCalls: number;
  readonly closedSshEndpoints: Set<string>;
  /** Whether the machine accepts TCP but its SSH server never responds, so a new command neither runs nor fails. */
  stalled: boolean;
  rootWritable: boolean;
  /** The machine's physical memory and swap in GiB, as `/proc/meminfo` reports them. */
  memoryGib: number;
  swapGib: number;
  /** The CPUs that `nproc` counts, and the kernel's `threads-max` and `pid_max`. */
  cpus: number;
  threadsMax: number;
  pidMax: number;
  /** Whether the SSH connection drops while the machine's resources are read, so `ssh` exits 255. */
  resourcesDisconnect: boolean;
  cacheExists: boolean;
  /** Paths that `find` lists under the Worker's `attempts` directory besides the existing checkout. */
  readonly attemptPaths: Array<string>;
  /** Whether a clone fails with git's token in its stderr. */
  cloneEchoesToken: boolean;
  /** The stderr of a clone that fails for another reason, such as a full disk. */
  cloneError: string | undefined;
  /** The checkout the salvage finds: clean, dirty, or one whose `git status` never answers. */
  salvage: "clean" | "dirty" | "stalls";
  salvageCommitted: boolean;
  claudeLoggedIn: boolean;
  /** What `codex --version` prints on the machine. */
  codexVersion: string;
  /**
   * How a command that starts with the stdin environment block runs: `received` decodes the block,
   * as POSIX `sh` with `base64` does; `dropped` runs the command without the variables; `no-base64`
   * exits 127 before the command, as `sh` without `base64` does; and `disconnects` loses the SSH
   * connection, so `ssh` exits 255.
   */
  stdinVariables: "received" | "dropped" | "no-base64" | "disconnects";
  /** Whether `git.<domain>` resolves and responds from the machine. */
  gatewayReachable: boolean;
  /** How many of the next requests to `git.<domain>` time out before the Gateway answers. */
  gatewayTimeouts: number;
  tailscaleJoin: "ready" | "refused";
  tailnetConfigure: "ready" | "refused";
  gatewayRefusal: string;
  /** Whether the Gateway's forward proxy responds to the machine. */
  forwardProxyReachable: boolean;
  /** Hosts that the forward proxy refuses to tunnel to. */
  readonly refusedHosts: Set<string>;
  /** The Gateway configuration files written on the machine, by path. */
  readonly files: Map<string, string>;
  /**
   * The Codex homes on the machine, by path, with whether the Attempt of each has a checkout. A
   * Codex home that the executor writes has none, so only its hold keeps a sweep from removing it.
   */
  readonly attemptHomes: Map<string, boolean>;
  /** Whether the Gateway accepts the SSH connection of a forward to its admin API. */
  gatewayAcceptsSsh: boolean;
  /** Every forward the executor started, in order. */
  readonly forwards: Array<FakeForward>;
  /**
   * Whether the machine has Docker, and whether its daemon answers the SSH user. With
   * `socket-only`, the SSH user is in the docker group, but the machine has no docker CLI.
   */
  podmanInfo: string | undefined;
  rootlessSessionError: string | undefined;
  limitsEnforced: boolean;
  runtimeExitCode: number;
  memoryEvents: "counted" | "unreadable" | "empty";
  /**
   * With `no-kills`, the kernel logs are readable and name no process killed for memory; with
   * `disconnects`, SSH loses the commands that read them.
   */
  kernelMemory: "readable" | "no-kills" | "unreadable" | "disconnects";
  /** How many processes a readable kernel log names as killed in a container. */
  kernelVictims: number;
  hostGroupId: string;
  imageGroupId: string;
  docker: "absent" | "running" | "unusable" | "socket-only";
  /** The stderr of a failed image pull, and whether the image is on the machine anyway. */
  pullError: string | undefined;
  imageOnMachine: boolean;
  imageInspectFailure: { readonly exitCode: number; readonly stderr: string } | undefined;
  imageId: string;
  pulledImageId: string;
  beforePull: Effect.Effect<void>;
  /** The user IDs on the machine and inside the Attempt image. */
  hostUserId: string;
  imageUserId: string;
  cachePreparationFailure: string | undefined;
  cachePreparationDuration: string;
  storeSizeKiB: string;
  /** The free disk space in GiB that `df` reports for the Worker's root, and for the image storage. */
  freeDiskGib: number;
  storageFreeDiskGib: number;
  diskReadError: string | undefined;
  storageProbe: "ready" | "info-fails" | "info-empty" | "df-fails";
  imageListError: string | undefined;
  containerListError: string | undefined;
  imageRemovalError: string | undefined;
  /** The images that `docker image ls` lists, as `<ID> <repository> <tag> <created at>` lines. */
  workerImages: Array<string>;
  /** The image IDs that the machine's containers use, as `docker container inspect` prints them. */
  containerImageIds: Array<string>;
  /** The arguments of each `docker image rm`. */
  readonly imageRemovals: Array<ReadonlyArray<string>>;
  /** The containers on the machine, by name. */
  readonly containers: Map<string, FakeContainer>;
  /** The number of containers that `docker run` created, which gives each its ID. */
  containersCreated: number;
  containerRemovalFails: boolean;
  /** The files under the SSH user's home, such as harness logins. */
  readonly homeFiles: Set<string>;
  /** Whether the checkout's `.git` is a file, as in a linked worktree of the cached clone. */
  linkedCheckout: boolean;
  /** The container markers on the machine, by path. */
  readonly markers: Set<string>;
  /** The files the executor wrote on the orchestrator's machine, such as host keys, by path. */
  readonly localFiles: Map<string, string>;
  /** Each write to `localFiles`, with the number of commands that ran before it. */
  readonly localWrites: Array<{ readonly path: string; readonly afterCalls: number }>;
}

/** Returns the ID of the `count`th container that the fake machine created, as Docker prints it. */
export const fakeContainerId = (count: number): string => count.toString(16).padStart(64, "0");

const oneShotHandle = (stdout: string, exitCode: number, stderr = "") => {
  const stdoutBytes = encoder.encode(stdout);
  const stderrBytes = encoder.encode(stderr);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    stdin: Sink.drain,
    stdout: stdout.length === 0 ? Stream.empty : Stream.make(stdoutBytes),
    stderr: stderr.length === 0 ? Stream.empty : Stream.make(stderrBytes),
    all: Stream.make(stdoutBytes, stderrBytes),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

/** An SSH client handle that never outputs or exits, like one waiting for a banner. */
const stalledHandle = ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(1),
  stdin: Sink.drain,
  stdout: Stream.never,
  stderr: Stream.never,
  all: Stream.never,
  exitCode: Effect.never,
  isRunning: Effect.succeed(true),
  kill: () => Effect.void,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
  unref: Effect.succeed(Effect.void),
});

/** Returns a Linux `/proc/meminfo` with `memoryGib` of memory and `swapGib` of swap. */
const meminfo = (memoryGib: number, swapGib: number): string => {
  const kib = (gib: number) => Math.round(gib * 1024 * 1024);
  return [
    `MemTotal:       ${kib(memoryGib)} kB`,
    `MemFree:        ${kib(memoryGib / 2)} kB`,
    `MemAvailable:   ${kib(memoryGib * 0.8)} kB`,
    `SwapTotal:      ${kib(swapGib)} kB`,
    `SwapFree:       ${kib(swapGib)} kB`,
    "",
  ].join("\n");
};

/** Returns the remote command line after `--` in an SSH invocation. */
const remoteLine = (command: ChildProcess.StandardCommand): string => {
  const separator = command.args.indexOf("--");
  return separator < 0 ? "" : (command.args[separator + 1] ?? "");
};

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Returns the unquoted words of a remote command line: `exec 'sh' '-c' ...` gives `sh`, `-c`, .... */
export const remoteWords = (line: string): Array<string> =>
  [...line.matchAll(/'((?:[^']|'"'"')*)'/gu)].map(([, word]) =>
    (word ?? "").replaceAll(`'"'"'`, "'"),
  );

/** Returns the value of `name` that a child host sends to the machine over stdin. */
export const stdinValue = (host: ChildHost, name: string): string => {
  const value = Schema.is(RemoteShell)(host) ? host.stdinEnvironment?.[name] : undefined;
  if (value === undefined) throw new Error(`The child host doesn't send ${name} over stdin`);
  return Redacted.value(value);
};

/** Returns the variables in a stdin environment block: a base64 line of `export NAME='value'`. */
const stdinExports = (block: string): Record<string, string> =>
  Object.fromEntries(
    [
      ...Buffer.from(block, "base64")
        .toString("utf8")
        .matchAll(/export ([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'"'"')*)'/gu),
    ].map(([, name = "", value = ""]) => [name, value.replaceAll(`'"'"'`, "'")]),
  );

/** The remote line that stops the Attempt's children before its checkout is kept or removed. */
export const KILL_CHILDREN = `exec 'sh' '-c' ${quote(CHILD_KILL_SCRIPT)} 'sh' '${WORKTREE}'`;

/** Returns the decoded bytes that the executor streams to a command's stdin. */
const standardInput = (command: ChildProcess.StandardCommand): Effect.Effect<string> => {
  const stdin = command.options.stdin;
  if (!Stream.isStream(stdin)) return Effect.succeed("");
  return Stream.runCollect(stdin).pipe(
    Effect.map((chunks) =>
      chunks.map((chunk) => (chunk instanceof Uint8Array ? decoder.decode(chunk) : "")).join(""),
    ),
    Effect.orDie,
  );
};

/** Returns a fake local SSH client and the Linux machine that every SSH Worker command runs on. */
export const fakeMachine = () => {
  const state: FakeMachineState = {
    outputCollection: '{"outputs":[]}',
    calls: [],
    credentials: new Map(),
    reachable: true,
    refusedCalls: 0,
    closedSshEndpoints: new Set(),
    stalled: false,
    rootWritable: true,
    memoryGib: 7.7,
    swapGib: 2,
    cpus: 4,
    threadsMax: 62_000,
    pidMax: 4_194_304,
    cacheExists: false,
    attemptPaths: [],
    cloneEchoesToken: false,
    cloneError: undefined,
    salvage: "clean",
    salvageCommitted: false,
    claudeLoggedIn: true,
    codexVersion: `codex-cli ${CODEX_CLI_VERSION}`,
    stdinVariables: "received",
    gatewayReachable: true,
    gatewayTimeouts: 0,
    tailscaleJoin: "ready",
    tailnetConfigure: "ready",
    gatewayRefusal: "missing-caller-token",
    forwardProxyReachable: true,
    refusedHosts: new Set(),
    files: new Map(),
    attemptHomes: new Map(),
    gatewayAcceptsSsh: true,
    forwards: [],
    podmanInfo: undefined,
    rootlessSessionError: undefined,
    limitsEnforced: true,
    runtimeExitCode: 0,
    memoryEvents: "counted",
    kernelMemory: "unreadable",
    kernelVictims: 1,
    hostGroupId: "1000",
    imageGroupId: "1000",
    docker: "absent",
    pullError: undefined,
    imageOnMachine: true,
    imageInspectFailure: undefined,
    resourcesDisconnect: false,
    imageId: "sha256:0123",
    pulledImageId: "sha256:0123",
    beforePull: Effect.void,
    imageUserId: "1000",
    hostUserId: "1000",
    cachePreparationFailure: undefined,
    cachePreparationDuration: "17\n",
    storeSizeKiB: "4096",
    freeDiskGib: 100,
    storageFreeDiskGib: 100,
    diskReadError: undefined,
    storageProbe: "ready",
    imageListError: undefined,
    containerListError: undefined,
    imageRemovalError: undefined,
    workerImages: [],
    containerImageIds: [],
    imageRemovals: [],
    containers: new Map(),
    containersCreated: 0,
    containerRemovalFails: false,
    homeFiles: new Set([".claude/.credentials.json", ".claude.json"]),
    linkedCheckout: false,
    markers: new Set(),
    localFiles: new Map(),
    localWrites: [],
  };
  /** Answers the commands that manage Docker containers, or returns `undefined` for others. */
  const respondToDocker = (commandLine: string, input: string) => {
    const line = commandLine.replace(/^exec 'podman'/u, "exec 'docker'");
    const words = remoteWords(line);
    if (line.includes("df -Pk")) {
      const kib = (gib: number) => Math.round(gib * 1024 ** 2);
      const script = words[2] ?? "";
      const root = words.at(-2) ?? "";
      const runtime = words.at(-1) ?? "";
      const probes = `
df() {
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
  case "$2" in
    ${quote(ADDRESS.root)})
      ${state.diskReadError === undefined ? `printf '/dev/data 200000000 1048576 ${kib(state.freeDiskGib)} 2%% /srv/usine\\n'` : `printf '%s\\n' ${quote(state.diskReadError)} >&2; return 1`} ;;
    /var/lib/docker|/var/lib/podman)
      ${state.storageProbe === "df-fails" ? "return 1" : `printf '/dev/images 200000000 1048576 ${kib(state.storageFreeDiskGib)} 2%% %s\\n' "$2"`} ;;
    /) printf '/dev/root 200000000 1048576 104857600 2%% /\\n' ;;
    *) printf '/dev/root 200000000 1048576 104857600 2%% %s\\n' "$2" ;;
  esac
}
docker() { [ "$1" = info ] && [ "$2" = --format ] && [ "$3" = '{{.DockerRootDir}}' ] || return 1; ${state.storageProbe === "info-fails" ? "return 1" : state.storageProbe === "info-empty" ? "return 0" : "printf '/var/lib/docker\\n'"}; }
podman() { [ "$1" = info ] && [ "$2" = --format ] && [ "$3" = '{{.Store.GraphRoot}}' ] || return 1; ${state.storageProbe === "info-fails" ? "return 1" : state.storageProbe === "info-empty" ? "return 0" : "printf '/var/lib/podman\\n'"}; }
`;
      const read = spawnSync("sh", ["-c", `${probes}\n${script}`, "sh", root, runtime], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (read.error !== undefined) throw read.error;
      return oneShotHandle(read.stdout, read.status ?? 1, read.stderr);
    }
    if (line.startsWith("exec 'docker' 'image' 'tag' ")) {
      const source = words[3] ?? "";
      const reference = words[4] ?? "";
      const original = state.workerImages.find(
        (image) =>
          image.split(" ")[0]?.replace(/^sha256:/u, "") === source.replace(/^sha256:/u, ""),
      );
      if (original === undefined) return oneShotHandle("", 1, "No such image");
      const [id, , , ...created] = original.split(" ");
      const colon = reference.lastIndexOf(":");
      state.workerImages = state.workerImages.filter(
        (image) => !image.startsWith(`${id} <none> <none> `),
      );
      state.workerImages.push(
        `${id} ${reference.slice(0, colon)} ${reference.slice(colon + 1)} ${created.join(" ")}`,
      );
      return oneShotHandle("", 0);
    }
    if (line.startsWith("exec 'docker' 'image' 'ls' "))
      return state.imageListError === undefined
        ? oneShotHandle(
            state.workerImages
              .filter((image) => words[6] === undefined || image.split(" ")[1] === words[6])
              .map((image) => `${image}\n`)
              .join(""),
            0,
          )
        : oneShotHandle("", 1, state.imageListError);
    if (line.includes("ps --all --quiet"))
      return state.containerListError === undefined
        ? oneShotHandle(state.containerImageIds.map((id) => `${id}\n`).join(""), 0)
        : oneShotHandle("", 1, state.containerListError);
    if (line.startsWith("exec 'docker' 'image' 'rm' ")) {
      const removed = words.slice(3);
      state.imageRemovals.push(removed);
      if (state.imageRemovalError !== undefined)
        return oneShotHandle("", 1, state.imageRemovalError);
      state.workerImages = state.workerImages.filter((image) => {
        const [id = "", repository = "", tag = ""] = image.split(" ");
        return (
          !removed.includes(`${repository}:${tag}`) &&
          !removed.includes(id.replace(/^sha256:/u, ""))
        );
      });
      return oneShotHandle("", 0);
    }
    if (line.includes("version -f")) {
      if (state.podmanInfo !== undefined)
        return oneShotHandle(`podman\n${state.podmanInfo}\n`, state.runtimeExitCode);
      return state.docker === "absent"
        ? oneShotHandle("", 3)
        : state.docker === "socket-only"
          ? oneShotHandle("", 4)
          : state.docker === "unusable"
            ? oneShotHandle(
                "",
                1,
                "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
              )
            : oneShotHandle("docker\n27.5.1\n", 0);
    }
    if (line.includes("loginctl show-user"))
      return state.rootlessSessionError === undefined
        ? oneShotHandle("", 0)
        : oneShotHandle(state.rootlessSessionError, 1);
    if (line.includes("/sys/fs/cgroup/cpu.max"))
      return oneShotHandle("", state.limitsEnforced ? 0 : 1);
    if (line.startsWith("exec 'docker' 'pull' ")) {
      if (state.pullError !== undefined) return oneShotHandle("", 1, state.pullError);
      state.imageOnMachine = true;
      state.imageId = state.pulledImageId;
      return oneShotHandle("", 0);
    }
    if (line.startsWith("exec 'docker' 'image' 'inspect' ")) {
      if (state.imageInspectFailure !== undefined)
        return oneShotHandle(
          "",
          state.imageInspectFailure.exitCode,
          state.imageInspectFailure.stderr,
        );
      return oneShotHandle(
        state.imageOnMachine ? `${state.imageId}\n` : "",
        state.imageOnMachine ? 0 : state.podmanInfo === undefined ? 1 : 125,
        state.imageOnMachine || state.podmanInfo === undefined ? "" : "Error: image not known\n",
      );
    }
    if (line.includes("volume create"))
      return state.cachePreparationFailure !== undefined &&
        words.includes(state.cachePreparationFailure)
        ? oneShotHandle("", 1, "cache volume: permission denied")
        : oneShotHandle(state.cachePreparationDuration, 0);
    if (words.includes("du")) return oneShotHandle(`${state.storeSizeKiB}\t/store\n`, 0);
    if (line.includes("--entrypoint"))
      return oneShotHandle(
        `${state.hostUserId} ${state.hostGroupId} ${state.imageUserId} ${state.imageGroupId}\n`,
        0,
      );
    if (line.includes("absolute=$3")) {
      // sh -c <script> sh docker <name> <count> <absolute paths...> <home files...>
      const [, , , , , name = "", count = "0", ...rest] = words;
      state.containers.delete(name);
      const absolute = rest.slice(0, Number(count));
      const home = rest.slice(Number(count)).filter((file) => state.homeFiles.has(file));
      return oneShotHandle(["/home/usine", ...absolute, ...home, ""].join("\n"), 0);
    }
    if (line.startsWith("exec 'docker' 'run' ")) {
      const name = words[words.indexOf("--name") + 1] ?? "";
      const labels = new Map(
        words.flatMap((word, index) => {
          if (words[index - 1] !== "--label") return [];
          const [key = "", ...value] = word.split("=");
          return [[key, value.join("=")] as const];
        }),
      );
      state.containersCreated += 1;
      const id = fakeContainerId(state.containersCreated);
      state.containers.set(name, {
        id,
        args: words.slice(1),
        labels,
        environment: input,
        running: true,
        initKilledForMemory: true,
        oomKills: 0,
      });
      return oneShotHandle(`${id}\n`, 0);
    }
    if (line.startsWith("exec 'docker' 'rm' '--force' ")) {
      if (state.containerRemovalFails) return oneShotHandle("", 1, "container removal failed");
      for (const name of words.slice(3)) state.containers.delete(name);
      return oneShotHandle("", 0);
    }
    if (line.startsWith("exec 'docker' 'container' 'inspect' ")) {
      const name = words.at(-1) ?? "";
      const container = state.containers.get(name);
      if (container === undefined) return oneShotHandle("", 1, `Error: No such container: ${name}`);
      return oneShotHandle(
        container.running
          ? "running 0 false\n"
          : container.initKilledForMemory
            ? "exited 137 true\n"
            : "exited 143 false\n",
        0,
      );
    }
    if (line.startsWith("exec 'docker' 'start' ")) {
      const name = words.at(-1) ?? "";
      const container = state.containers.get(name);
      if (container === undefined)
        return oneShotHandle("", 1, `Error response from daemon: No such container: ${name}`);
      container.running = true;
      container.oomKills = 0;
      return oneShotHandle(`${name}\n`, 0);
    }
    if (line.includes("memory.events")) {
      // sh -c <script> sh docker <name>
      const name = words.at(-1) ?? "";
      const container = state.containers.get(name);
      if (container === undefined) return oneShotHandle("", 1, `Error: No such container: ${name}`);
      if (state.memoryEvents === "unreadable")
        return oneShotHandle("", 1, "memory.events: permission denied");
      if (state.memoryEvents === "empty") return oneShotHandle(`container ${container.id}\n`, 0);
      return oneShotHandle(
        `container ${container.id}\n` +
          (container.running
            ? `low 0\nhigh 0\nmax 9\noom ${container.oomKills}\noom_kill ${container.oomKills}\noom_group_kill 0\n`
            : `oom_kill ${container.initKilledForMemory ? 1 : 0}\n`),
        0,
      );
    }
    if (line.includes("journalctl -k") && state.kernelMemory === "disconnects")
      return oneShotHandle("", 255, "Connection to 203.0.113.7 closed by remote host.\n");
    // The collection script also checks the journal's readability, so it goes first.
    if (line.includes("journalctl -k --since")) {
      if (state.kernelMemory === "unreadable")
        return oneShotHandle("", 1, "dmesg: read kernel buffer failed: Operation not permitted");
      const container = state.containers.get(words.at(-1) ?? "");
      return oneShotHandle(
        container === undefined || state.kernelMemory === "no-kills"
          ? "source dmesg\n"
          : `source journal\n${Array.from(
              { length: state.kernelVictims },
              (_, index) =>
                `oom-kill:constraint=CONSTRAINT_MEMCG,oom_memcg=/docker/${container.id},task_memcg=/docker/${container.id},task=vitest worker,pid=${1234 + index},uid=1000\n`,
            ).join("")}`,
        0,
      );
    }
    if (line.includes("journalctl -k -b")) {
      return oneShotHandle("", state.kernelMemory === "unreadable" ? 1 : 0);
    }
    if (line.includes("container inspect")) {
      const container = state.containers.get(words[5] ?? "");
      return oneShotHandle(
        container === undefined
          ? "no-container\n"
          : container.running
            ? "no-children\n"
            : "container-stopped\n",
        0,
      );
    }
    if (line.includes("ps --all")) {
      if (words[4] !== (state.podmanInfo === undefined ? "docker" : "podman"))
        return oneShotHandle("", 127, "selected container runtime is not installed");
      // sh -c <script> sh docker <label> <label>; a container must have both, as with docker ps.
      const filters = words.slice(5, 7).map((label) => label.split("="));
      const listed = [...state.containers].filter(([, container]) =>
        filters.every(([key = "", value = ""]) => container.labels.get(key) === value),
      );
      return oneShotHandle(
        listed
          .map(
            ([name, container]) => `${name} ${container.labels.get("dev.usine.process") ?? ""}\n`,
          )
          .join(""),
        0,
      );
    }
    if (line.includes(': > "$1"')) {
      state.markers.add(words.at(-1) ?? "");
      return oneShotHandle("", 0);
    }
    if (line.includes('rm -f "$2"')) {
      state.markers.delete(words.at(-1) ?? "");
      return oneShotHandle("", 0);
    }
    if (line.startsWith("exec 'test' '-f' ")) {
      const path = words.at(-1) ?? "";
      if (path.endsWith("/.git")) return oneShotHandle("", state.linkedCheckout ? 0 : 1);
      return oneShotHandle("", state.markers.has(path) ? 0 : 1);
    }
    return undefined;
  };
  const respond = (
    command: ChildProcess.StandardCommand,
    line: string,
    input: string,
    stdinEnvironment: Readonly<Record<string, string>>,
  ) => {
    const configIndex = command.args.indexOf("-F");
    const config = state.localFiles.get(command.args[configIndex + 1] ?? "") ?? "";
    const destination = command.args[command.args.indexOf("--") - 1] ?? "";
    const host = /^  HostName (\S+)$/mu.exec(config)?.[1] ?? destination.split("@").at(-1);
    const portIndex = command.args.indexOf("-p");
    const port =
      portIndex < 0 ? (/^  Port (\d+)$/mu.exec(config)?.[1] ?? "22") : command.args[portIndex + 1];
    if (state.closedSshEndpoints.has(`${host}:${port}`))
      return oneShotHandle(
        "",
        255,
        `ssh: connect to host ${host} port ${port}: Connection refused`,
      );
    if (state.stalled) return stalledHandle;
    if (!state.reachable) {
      state.refusedCalls += 1;
      return oneShotHandle(
        "",
        255,
        "ssh: connect to host 203.0.113.7 port 2222: Connection refused",
      );
    }
    const docker = respondToDocker(line, input);
    if (docker !== undefined) return docker;
    if (line.includes("# usine-tailnet"))
      return state.tailnetConfigure === "ready"
        ? oneShotHandle("", 0)
        : oneShotHandle("", 1, "sudo: a password is required");
    if (line.includes("'tailscale' 'up'") && state.tailscaleJoin === "refused")
      return oneShotHandle("", 1, `auth key refused: ${input}`);
    if (line === "exec 'true'") return oneShotHandle("", 0);
    if (line.includes("printenv")) {
      const expected = remoteWords(line).slice(4);
      const dropped = expected.filter(
        (word, index) => index % 2 === 0 && stdinEnvironment[word] !== expected[index + 1],
      );
      return oneShotHandle(dropped.map((name) => `${name}\n`).join(""), 0);
    }
    // Responds to the login host check like curl through the forward proxy: the CONNECT status, then the host's status.
    if (line.includes("http_connect")) {
      const answer = (host: string) => {
        if (!state.forwardProxyReachable) return `${host} 28 000 000\n`;
        if (state.refusedHosts.has(host)) return `${host} 56 403 000\n`;
        return `${host} 0 200 404\n`;
      };
      return oneShotHandle(remoteWords(line).slice(5).map(answer).join(""), 0);
    }
    if (line.startsWith("exec 'curl'") && state.gatewayTimeouts > 0) {
      state.gatewayTimeouts -= 1;
      return oneShotHandle("", 28, "curl: (28) Operation timed out after 13000 milliseconds");
    }
    if (line.startsWith("exec 'curl'"))
      return state.gatewayReachable
        ? oneShotHandle(
            `HTTP/1.1 401 Unauthorized\r\nx-usine-gateway-refusal: ${state.gatewayRefusal}\r\n\r\n`,
            0,
          )
        : oneShotHandle("", 6, "curl: (6) Could not resolve host: git.gw.test");
    if (line.includes('rm -rf "$1"') && line.includes("retained")) {
      const home = remoteWords(line).at(-2) ?? "";
      if (state.attemptHomes.get(home) === true) return oneShotHandle("retained", 0);
      state.attemptHomes.delete(home);
      return oneShotHandle("removed", 0);
    }
    // Lists harness homes whose attempt has no checkout.
    if (line.includes("basename")) {
      const root = remoteWords(line).at(-2) ?? "";
      const listed = [...state.attemptHomes].filter(
        ([home, checkout]) => home.startsWith(`${root}/`) && !checkout,
      );
      return oneShotHandle(listed.map(([home]) => `${home}${NUL}`).join(""), 0);
    }
    // Writes configuration files: path and contents pairs after the script and `$0`.
    if (line.includes('mv "$1.$$" "$1"')) {
      const words = remoteWords(line);
      const pairs = words.slice(words.findIndex((word) => word.includes("shift 2")) + 2);
      for (let index = 0; index + 1 < pairs.length; index += 2) {
        const path = pairs[index] ?? "";
        state.files.set(path, pairs[index + 1] ?? "");
        const codexHome = /^(.+\/codex\/[^/]+)\/config\.toml$/u.exec(path)?.[1];
        if (codexHome !== undefined)
          state.attemptHomes.set(codexHome, state.attemptHomes.get(codexHome) ?? false);
      }
      return oneShotHandle("", 0);
    }
    if (line.includes("IFS= read -r token")) {
      const directory = line.slice(line.lastIndexOf(" '") + 2, -1);
      state.credentials.set(directory, input.split("\n")[0] ?? "");
      return oneShotHandle("", 0);
    }
    if (line.includes("test -d") && line.includes("test -w"))
      return oneShotHandle("", state.rootWritable ? 0 : 1);
    if (line === "exec 'cat' '/proc/meminfo'")
      return oneShotHandle(meminfo(state.memoryGib, state.swapGib), 0);
    if (line.includes("nproc") && state.resourcesDisconnect)
      return oneShotHandle("", 255, "Connection to 203.0.113.7 closed by remote host.\n");
    if (line.includes("nproc"))
      return oneShotHandle(
        `${state.cpus}\n${state.threadsMax}\n${state.pidMax}\n${meminfo(state.memoryGib, state.swapGib)}`,
        0,
      );
    if (line.includes("pidfile")) return oneShotHandle("no-children\n", 0);
    if (line.includes('for directory in "$root"/*')) {
      const [, , , , root = "", ...active] = remoteWords(line);
      for (const directory of state.credentials.keys()) {
        if (directory.startsWith(`${root}/`) && !active.includes(directory))
          state.credentials.delete(directory);
      }
      return oneShotHandle("", 0);
    }
    if (line.startsWith("exec 'rm' '-rf' ")) {
      for (const target of remoteWords(line).slice(2)) {
        state.attemptHomes.delete(target);
        for (const directory of state.credentials.keys())
          if (directory === target || directory.startsWith(`${target}/`))
            state.credentials.delete(directory);
      }
      return oneShotHandle("", 0);
    }
    if (line.includes("const collect = () =>")) return oneShotHandle(state.outputCollection, 0);
    if (line === "exec 'git' '--version'") return oneShotHandle("git version 2.47.3\n", 0);
    if (line === "exec 'claude' '--version'") return oneShotHandle(claudeVersionOutput, 0);
    if (line === "exec 'node' '--version'") return oneShotHandle("v24.11.0\n", 0);
    if (
      line ===
      "exec 'codex' '-c' 'features.multi_agent=false' '-c' 'features.plugins=false' '-c' 'features.remote_plugin=false' '-c' 'features.apps=false' '-c' 'check_for_update_on_startup=false' '-c' 'analytics.enabled=false' '--version'"
    )
      return oneShotHandle(`${state.codexVersion}\n`, 0);
    if (line === "exec 'claude' 'auth' 'status' '--json'")
      return oneShotHandle(
        jsonKey({
          loggedIn: state.claudeLoggedIn,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
        }),
        0,
      );
    if (line.startsWith("exec 'mv' ")) {
      state.cacheExists = true;
      return oneShotHandle("", 0);
    }
    if (line.startsWith("exec 'find' ") && line.includes("/attempts'")) {
      const listed = [
        ...(state.cacheExists ? [`${WORKER_ROOT}/attempts/remote-run_execute_1`] : []),
        ...state.attemptPaths,
      ];
      return oneShotHandle(listed.map((entry) => `${entry}${NUL}`).join(""), 0);
    }
    if (line.startsWith("exec 'find' ") && line.includes("/repos'"))
      return oneShotHandle(`${WORKER_ROOT}/repos/acme_demo.git${NUL}`, 0);
    if (line.startsWith("exec 'test' ")) return oneShotHandle("", state.cacheExists ? 0 : 1);
    if (line.includes("&& exec 'git' 'clone'") && state.cloneError !== undefined)
      return oneShotHandle("", 128, state.cloneError);
    if (line.includes("&& exec 'git' 'clone'") && state.cloneEchoesToken) {
      const token = [...state.credentials.values()].at(-1) ?? "";
      return oneShotHandle(
        "",
        128,
        `fatal: Authentication failed for 'https://x-access-token:${token}@github.com/'`,
      );
    }
    if (line.startsWith("cd ") && line.includes("&& exec 'git' 'log'")) return oneShotHandle("", 0);
    if (line.startsWith("cd ") && line.includes("&& exec 'git' 'rev-parse' 'HEAD'"))
      return oneShotHandle(`${COMMIT}\n`, 0);
    if (line.startsWith("cd ") && line.includes("&& exec 'git' 'branch' '--show-current'"))
      return oneShotHandle("", 0);
    if (line.includes("exec 'git' '-C' ")) {
      if (line.includes("'--absolute-git-dir'")) return oneShotHandle(`${GIT_DIRECTORY}\n`, 0);
      if (line.includes("'rev-parse'"))
        return oneShotHandle(`${state.salvageCommitted ? SALVAGE_COMMIT : COMMIT}\n`, 0);
      if (line.includes("'status'")) {
        if (state.salvage === "stalls") return stalledHandle;
        return oneShotHandle(state.salvage === "clean" ? "" : " M src/index.ts\n", 0);
      }
      if (line.includes("'diff' '--cached'"))
        return oneShotHandle(state.salvage === "clean" ? "" : "src/index.ts\0", 0);
      if (line.includes("'commit'")) state.salvageCommitted = true;
      return oneShotHandle("", 0);
    }
    if (line.includes("exec 'git' '--git-dir'") && line.includes("'rev-parse'"))
      return oneShotHandle(`${COMMIT}\n`, 0);
    return oneShotHandle("", 0);
  };
  // Behaves like `ssh -N -L 127.0.0.1:<port>:127.0.0.1:<admin port> <gateway>`: prints its LocalCommand output once listening, then runs until dropped or killed.
  const startForward = Effect.fn("FakeMachine.startForward")(function* (
    command: ChildProcess.StandardCommand,
  ) {
    if (!state.gatewayAcceptsSsh)
      return oneShotHandle(
        "",
        255,
        "ssh: connect to host 203.0.113.30 port 22: Connection refused",
      );
    const [, port] = (command.args[command.args.indexOf("-L") + 1] ?? "").split(":");
    const echo = "LocalCommand=echo ";
    const opened = command.args.find((arg) => arg.startsWith(echo))?.slice(echo.length) ?? "";
    const exited = yield* Deferred.make<{ readonly code: number; readonly stderr: string }>();
    const end = (code: number, stderr: string) =>
      Effect.suspend(() => {
        forward.live = false;
        return Deferred.succeed(exited, { code, stderr });
      }).pipe(Effect.asVoid);
    const forward: FakeForward = {
      command,
      port: Number(port),
      live: true,
      carries: true,
      drop: end(255, "Connection to 203.0.113.30 closed by remote host."),
    };
    state.forwards.push(forward);
    yield* Effect.addFinalizer(() => end(143, ""));
    const finished = Deferred.await(exited);
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(2),
      stdin: Sink.drain,
      stdout: Stream.make(encoder.encode(`${opened}\n`)).pipe(
        Stream.concat(Stream.drain(Stream.fromEffect(finished))),
      ),
      stderr: Stream.fromEffect(finished).pipe(Stream.map(({ stderr }) => encoder.encode(stderr))),
      all: Stream.empty,
      exitCode: Effect.map(finished, ({ code }) => ChildProcessSpawner.ExitCode(code)),
      isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
      kill: () => end(143, ""),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  });
  const service = ChildProcessSpawner.make(
    Effect.fn("FakeMachine.spawn")(function* (command) {
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
      let line = remoteLine(command);
      let input = yield* standardInput(command);
      let stdinEnvironment: Readonly<Record<string, string>> = {};
      if (line.startsWith(STDIN_ENVIRONMENT_PREFIX)) {
        const boundary = input.indexOf("\n");
        if (state.stdinVariables === "received")
          stdinEnvironment = stdinExports(input.slice(0, boundary));
        input = input.slice(boundary + 1);
        line = line.slice(STDIN_ENVIRONMENT_PREFIX.length);
        if (state.stdinVariables === "no-base64") {
          state.calls.push({ command, line, input, stdinEnvironment });
          return oneShotHandle("", 127, "sh: 1: base64: not found\n");
        }
        if (state.stdinVariables === "disconnects") {
          state.calls.push({ command, line, input, stdinEnvironment });
          return oneShotHandle("", 255, "Connection to 203.0.113.7 closed by remote host.\n");
        }
      }
      if (command.args.includes("-N")) {
        state.calls.push({ command, line, input, stdinEnvironment });
        return yield* startForward(command);
      }
      // Runs a `docker exec` line's command as if inside the container.
      if (/^exec '(?:docker|podman)' 'exec' '-i' /u.test(line)) {
        const [, , , container = "", , , inner = ""] = remoteWords(line);
        state.calls.push({ command, line: inner, input, stdinEnvironment, container });
        const running = state.containers.get(container)?.running;
        if (running === undefined)
          return oneShotHandle(
            "",
            1,
            `Error response from daemon: No such container: ${container}`,
          );
        return running
          ? respond(command, inner, input, stdinEnvironment)
          : oneShotHandle("", 1, "Error response from daemon: container 4f0c2d is not running");
      }
      // Records `docker run` behind the pipe that gives it standard input as the docker command.
      const piped = `exec 'sh' '-c' ${quote('cat | "$@"')} 'sh' `;
      const direct = line.startsWith(piped)
        ? `exec ${remoteWords(line)
            .slice(4)
            .map((word) => quote(word))
            .join(" ")}`
        : line;
      state.calls.push({ command, line: direct, input, stdinEnvironment });
      if (/^exec '(?:docker|podman)' 'pull' /u.test(direct)) yield* state.beforePull;
      return respond(command, direct, input, stdinEnvironment);
    }),
  );
  const fileSystem = FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    makeTempDirectoryScoped: () => Effect.succeed(LOCAL_TEMPORARY_DIRECTORY),
    readFileString: (path) =>
      Effect.fromOption(Option.fromNullishOr(state.localFiles.get(path)), () =>
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readFileString",
          description: "No such file",
          pathOrDescriptor: path,
        }),
      ),
    writeFileString: (path, data) =>
      Effect.sync(() => {
        state.localFiles.set(path, data);
        state.localWrites.push({ path, afterCalls: state.calls.length });
      }),
    rename: (oldPath, newPath) =>
      Effect.sync(() => {
        const content = state.localFiles.get(oldPath);
        state.localFiles.delete(oldPath);
        if (content !== undefined) state.localFiles.set(newPath, content);
      }),
    exists: (path) => Effect.succeed(state.localFiles.has(path)),
    remove: (path) => Effect.sync(() => void state.localFiles.delete(path)),
  });
  return {
    state,
    /** The fake's process spawner, which answers commands as the machine would. */
    spawner: service,
    layer: Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service),
      fileSystem,
      Path.layer,
    ),
  };
};

/** Returns a provider that mints a distinct token per request (one hour by default) and records the requested permission level. */
export const mintingProvider = (lifetimeMillis = 3_600_000) => {
  const minted: Array<string> = [];
  const permissions: Array<LoopPermissions> = [];
  const layer = Layer.succeed(CredentialProvider)({
    issue: (_repository, _attemptId, level) =>
      Effect.gen(function* () {
        const token = `${TOKEN_PREFIX}${minted.length + 1}`;
        minted.push(token);
        permissions.push(level);
        return WorkerCredential.make({
          value: Redacted.make(token),
          expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + lifetimeMillis),
        });
      }),
  });
  return { minted, permissions, layer };
};

/** The bot account that commits in the fixture Attempts. */
export const COMMIT_AUTHOR = BotAccount.make({
  login: BotLogin.make("usine-test[bot]"),
  id: BotUserId.make(4242),
});

/** The exports in a remote git command line that make `COMMIT_AUTHOR` its author and committer. */
export const BOT_COMMITS =
  "GIT_AUTHOR_NAME='usine-test[bot]' GIT_AUTHOR_EMAIL='4242+usine-test[bot]@users.noreply.github.com' GIT_COMMITTER_NAME='usine-test[bot]' GIT_COMMITTER_EMAIL='4242+usine-test[bot]@users.noreply.github.com'";

export const request = CheckoutRequest.make({
  attemptId: ATTEMPT_ID,
  worker: WORKER,
  repository: REPOSITORY,
  loop: LoopName.make("implement"),
  permissions: "write",
  revision: RepositoryRevision.make("main"),
  payload: { issue: { number: 42 } },
  task: AttemptTask.make("Complete the remote task"),
  agent: TEST_AGENT,
  parentModel: Option.none(),
  maxChildren: ChildSessionBudget.make(4),
  maxAttemptMinutes: Option.none(),
  maxAttemptTokens: Option.none(),
  parentEffort: "high",
  salvageRef: SalvageRef.make("usine/salvage/remote-run/1"),
  resume: Option.none(),
  requiresCi: false,
  commitAuthor: COMMIT_AUTHOR,
});

/** A parent that fails the Attempt like a crash. */
export const fails: StubParent = () =>
  Effect.fail(InfraFailure.make({ message: "The parent stopped", cause: new Error("crash") }));

/** Whether a remote command line writes an Attempt's token on the machine. */
export const writesCredential = (line: string) => line.includes("IFS= read -r token");

/** Returns a logger that collects every log message and its fields as text. */
export const CapturedLog = Schema.fromJsonString(
  Schema.Tuple([Schema.Unknown, Schema.Record(Schema.String, Schema.Unknown)]),
);

export const capturedLogs = () => {
  const lines: Array<string> = [];
  const warnings: Array<string> = [];
  const infos: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ message, logLevel }) => {
    const line = jsonKey(message);
    lines.push(line);
    if (logLevel === "Warn") warnings.push(line);
    if (logLevel === "Info") infos.push(line);
  });
  return { lines, warnings, infos, layer: Logger.layer([logger]) };
};

/** The test Worker's address, without a Gateway. */
export const ADDRESS: SshWorkerAddress = {
  name: WORKER,
  machine: { _tag: "Fixed", tailnet: Option.none(), destination: DESTINATION },
  identityFile: Option.some(SshIdentityFile.make("~/.ssh/usine_worker")),
  port: Option.some(SshPort.make(2222)),
  root: WorkerRoot.make("/srv/usine"),
  gateway: Option.none(),
  container: {
    image: Option.none(),
    cpus: Option.some(ContainerCpus.make(2)),
    memoryMib: Option.some(ContainerMemoryMib.make(4096)),
    pids: Option.some(ContainerPids.make(4096)),
    shmSizeMib: Option.none(),
    tmpfsSizeMib: Option.none(),
  },
};

/** The instance label of the test executor's containers. */
export const INSTANCE = "github-app-4242";
/** The instance ID label of the test executor's containers. */
export const INSTANCE_ID = InstanceId.make("0b4e7f3c-5a2d-4c1e-9f6b-8d7a2e1c3b4f");

/** An HTTP client layer for a Worker without a Gateway; never called. */
export const noGateway = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die(new Error("A Worker without a Gateway made an HTTP request"))),
);

/**
 * Returns the SSH executor for `address` on the fake machine, with parents scripted by
 * `parent` and tokens minted by `credentials`. The caller provides the HTTP client for the
 * Gateway's admin API.
 */
export const executorLayer = (
  machine: ReturnType<typeof fakeMachine>,
  credentials: ReturnType<typeof mintingProvider>,
  address: SshWorkerAddress,
  parent: StubParent = completes,
  /** Rebuilding on the same storage simulates an orchestrator restart. */
  storage: StubStorage = new StubStorage(),
  /** Replaces the executor's own login and binary checks. */
  probes: Pick<SshExecutorOptions, "harnessReadiness" | "attemptConnections"> = {},
  harnesses: typeof harnessesLive = harnessesLive,
) =>
  sshLayer({
    workers: [address],
    instance: INSTANCE,
    instanceId: INSTANCE_ID,
    interruptGrace: "2 seconds",
    ...probes,
  }).pipe(
    Layer.provide(harnesses),
    Layer.provide(machine.layer),
    Layer.provide(credentials.layer),
    Layer.provide(stubAttemptRuntime(storage, parent)),
    Layer.provide(hostLoginLockLayer),
  );

/**
 * Returns the SSH executor for one Worker without a Gateway on the fake machine, with parents
 * scripted by `parent` and tokens minted by `credentials`.
 */
export const runtime = (
  machine: ReturnType<typeof fakeMachine>,
  credentials: ReturnType<typeof mintingProvider>,
  parent: StubParent = completes,
  /** Rebuilding on the same storage simulates an orchestrator restart. */
  storage: StubStorage = new StubStorage(),
) => executorLayer(machine, credentials, ADDRESS, parent, storage).pipe(Layer.provide(noGateway));
