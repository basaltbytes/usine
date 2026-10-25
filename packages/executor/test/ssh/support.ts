import { CHILD_KILL_SCRIPT } from "@usine/agents/child-host";
import { CODEX_CLI_VERSION } from "@usine/agents/preflight";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptTask, AttemptId, AttemptWindow, AttemptWindows } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
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
  Layer,
  Logger,
  Option,
  Redacted,
  Sink,
  Stream,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { StandardCommand } from "effect/unstable/process/ChildProcess";
import {
  CheckoutRequest,
  claudeLoginLockLayer,
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
    new AttemptWindows({
      own: Option.some(
        new AttemptWindow({ attemptId, startedAt: DateTime.makeUnsafe(0), endedAt: Option.none() }),
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
export const TEST_AGENT = new Agent({
  name: AgentName.make("developer"),
  brain: new BrainSpec({
    harness: "claude",
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the task."),
});

const NUL = String.fromCharCode(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface RemoteCall {
  readonly command: StandardCommand;
  readonly line: string;
  readonly input: string;
  /** The container that ran the command, if it ran through `docker exec`. */
  readonly container?: string;
}

/** A container on the fake machine. */
interface FakeContainer {
  /** The arguments of its `docker run`. */
  readonly args: ReadonlyArray<string>;
  readonly labels: ReadonlyMap<string, string>;
  /** The `--env-file` content read from standard input. */
  readonly environment: string;
}

/** A fake SSH client that forwards a local port to a Gateway's admin API. */
interface FakeForward {
  readonly command: StandardCommand;
  readonly port: number;
  /** Whether the client is running. */
  live: boolean;
  /** Whether requests through the client are delivered to the admin API. If false, the connection is dead but the client hasn't detected it. */
  carries: boolean;
  /** Ends the client like a dropped connection. */
  readonly drop: Effect.Effect<void>;
}

interface FakeMachineState {
  readonly calls: Array<RemoteCall>;
  /** The token in each credential directory on the machine, by path. */
  readonly credentials: Map<string, string>;
  reachable: boolean;
  /** Whether the machine accepts TCP but its SSH server never responds, so a new command neither runs nor fails. */
  stalled: boolean;
  rootWritable: boolean;
  /** The machine's physical memory and swap in GiB, as `/proc/meminfo` reports them. */
  memoryGib: number;
  swapGib: number;
  cacheExists: boolean;
  /** Whether a clone fails with git's token in its stderr. */
  cloneEchoesToken: boolean;
  salvage: "clean" | "dirty";
  salvageCommitted: boolean;
  claudeLoggedIn: boolean;
  /** What `codex --version` prints on the machine. */
  codexVersion: string;
  /** Whether sshd accepts the variables the SSH client sends (`AcceptEnv`). */
  acceptsSentVariables: boolean;
  readonly droppedSentVariables: Set<string>;
  /** Whether `git.<domain>` resolves and responds from the machine. */
  gatewayReachable: boolean;
  /** Whether the Gateway's forward proxy responds to the machine. */
  forwardProxyReachable: boolean;
  /** Hosts that the forward proxy refuses to tunnel to. */
  readonly refusedHosts: Set<string>;
  /** The Gateway configuration files written on the machine, by path. */
  readonly files: Map<string, string>;
  /** Whether the Gateway accepts the SSH connection of a forward to its admin API. */
  gatewayAcceptsSsh: boolean;
  /** Every forward the executor started, in order. */
  readonly forwards: Array<FakeForward>;
  /**
   * Whether the machine has Docker, and whether its daemon answers the SSH user. With
   * `socket-only`, the SSH user is in the docker group, but the machine has no docker CLI.
   */
  docker: "absent" | "running" | "unusable" | "socket-only";
  /** Whether `docker pull` of the Attempt image fails, and whether the image is on the machine anyway. */
  pullFails: boolean;
  imageOnMachine: boolean;
  /** The user ID inside the Attempt image. The SSH user's is 1000. */
  imageUserId: string;
  /** The containers on the machine, by name. */
  readonly containers: Map<string, FakeContainer>;
  /** The files under the SSH user's home, such as harness logins. */
  readonly homeFiles: Set<string>;
  /** Whether the checkout's `.git` is a file, as in a linked worktree of the cached clone. */
  linkedCheckout: boolean;
  /** The container markers on the machine, by path. */
  readonly markers: Set<string>;
}

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
const remoteLine = (command: StandardCommand): string => {
  const separator = command.args.indexOf("--");
  return separator < 0 ? "" : (command.args[separator + 1] ?? "");
};

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Returns the unquoted words of a remote command line: `exec 'sh' '-c' ...` gives `sh`, `-c`, .... */
const remoteWords = (line: string): Array<string> =>
  [...line.matchAll(/'((?:[^']|'"'"')*)'/gu)].map(([, word]) =>
    (word ?? "").replaceAll(`'"'"'`, "'"),
  );

/** Returns the variables an SSH invocation sends to the machine that have a value in its environment. */
export const sentVariables = (command: StandardCommand): Array<string> => {
  const option = command.args.find((arg) => arg.startsWith("SendEnv="));
  const names = option === undefined ? [] : option.slice("SendEnv=".length).split(" ");
  return names.filter((name) => command.options.env?.[name] !== undefined);
};

/** The remote line that stops the Attempt's children before its checkout is kept or removed. */
export const KILL_CHILDREN = `exec 'sh' '-c' ${quote(CHILD_KILL_SCRIPT)} 'sh' '${WORKTREE}'`;

/** Returns the decoded bytes that the executor streams to a command's stdin. */
const standardInput = (command: StandardCommand): Effect.Effect<string> => {
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
    calls: [],
    credentials: new Map(),
    reachable: true,
    stalled: false,
    rootWritable: true,
    memoryGib: 7.7,
    swapGib: 2,
    cacheExists: false,
    cloneEchoesToken: false,
    salvage: "clean",
    salvageCommitted: false,
    claudeLoggedIn: true,
    codexVersion: `codex-cli ${CODEX_CLI_VERSION}`,
    acceptsSentVariables: true,
    droppedSentVariables: new Set(),
    gatewayReachable: true,
    forwardProxyReachable: true,
    refusedHosts: new Set(),
    files: new Map(),
    gatewayAcceptsSsh: true,
    forwards: [],
    docker: "absent",
    pullFails: false,
    imageOnMachine: true,
    imageUserId: "1000",
    containers: new Map(),
    homeFiles: new Set([".claude/.credentials.json", ".claude.json"]),
    linkedCheckout: false,
    markers: new Set(),
  };
  /** Answers the commands that manage Docker containers, or returns `undefined` for others. */
  const respondToDocker = (line: string, input: string) => {
    const words = remoteWords(line);
    if (line.includes("version -f"))
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
            : oneShotHandle("27.5.1\n", 0);
    if (line.startsWith("exec 'docker' 'pull' "))
      return state.pullFails
        ? oneShotHandle("", 1, "Error response from daemon: Get https://ghcr.io/v2/: timeout")
        : oneShotHandle("", 0);
    if (line.startsWith("exec 'docker' 'image' 'inspect' "))
      return oneShotHandle(
        state.imageOnMachine ? "sha256:0123\n" : "",
        state.imageOnMachine ? 0 : 1,
      );
    if (line.includes("--entrypoint")) return oneShotHandle(`1000 ${state.imageUserId}\n`, 0);
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
      state.containers.set(name, { args: words.slice(1), labels, environment: input });
      return oneShotHandle("4f0c2d\n", 0);
    }
    if (line.startsWith("exec 'docker' 'rm' '--force' ")) {
      for (const name of words.slice(3)) state.containers.delete(name);
      return oneShotHandle("", 0);
    }
    if (line.includes("container inspect")) {
      const name = words[5] ?? "";
      return oneShotHandle(state.containers.has(name) ? "no-children\n" : "no-container\n", 0);
    }
    if (line.includes("ps --all")) {
      const label = words[5] ?? "";
      const [key = "", value = ""] = label.split("=");
      const listed = [...state.containers].filter(
        ([, container]) => container.labels.get(key) === value,
      );
      return oneShotHandle(
        listed
          .map(([name, container]) => `${name} ${container.labels.get("dev.usine.worker") ?? ""}\n`)
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
  const respond = (command: StandardCommand, line: string, input: string) => {
    if (state.stalled) return stalledHandle;
    if (!state.reachable)
      return oneShotHandle(
        "",
        255,
        "ssh: connect to host 203.0.113.7 port 2222: Connection refused",
      );
    const docker = respondToDocker(line, input);
    if (docker !== undefined) return docker;
    if (line === "exec 'true'") return oneShotHandle("", 0);
    if (line.includes("printenv")) {
      const received = state.acceptsSentVariables
        ? sentVariables(command).filter((name) => !state.droppedSentVariables.has(name))
        : [];
      const expected = remoteWords(line).slice(4);
      const dropped = expected.filter((word, index) => index % 2 === 0 && !received.includes(word));
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
    if (line.startsWith("exec 'curl'"))
      return state.gatewayReachable
        ? oneShotHandle(
            "HTTP/1.1 401 Unauthorized\r\nx-usine-gateway-refusal: missing-caller-token\r\n\r\n",
            0,
          )
        : oneShotHandle("", 6, "curl: (6) Could not resolve host: git.gw.test");
    // Writes the Gateway configuration files: path and contents pairs after the script and `$0`.
    if (line.includes("http_unix_socket")) {
      const words = remoteWords(line);
      const pairs = words.slice(words.findIndex((word) => word.includes("shift 2")) + 2);
      for (let index = 0; index + 1 < pairs.length; index += 2)
        state.files.set(pairs[index] ?? "", pairs[index + 1] ?? "");
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
    if (line.includes("pidfile")) return oneShotHandle("no-children\n", 0);
    if (line.startsWith("exec 'rm' '-rf' ")) {
      const target = line.slice("exec 'rm' '-rf' '".length, -1);
      for (const directory of state.credentials.keys())
        if (directory === target || directory.startsWith(`${target}/`))
          state.credentials.delete(directory);
      return oneShotHandle("", 0);
    }
    if (line === "exec 'git' '--version'") return oneShotHandle("git version 2.47.3\n", 0);
    if (line === "exec 'claude' '--version'") return oneShotHandle(claudeVersionOutput, 0);
    if (line === "exec 'codex' '--version'") return oneShotHandle(`${state.codexVersion}\n`, 0);
    if (line === "exec 'claude' 'auth' 'status' '--json'")
      return oneShotHandle(
        JSON.stringify({
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
      const listed = state.cacheExists ? [`${WORKER_ROOT}/attempts/remote-run_execute_1`] : [];
      return oneShotHandle(listed.map((entry) => `${entry}${NUL}`).join(""), 0);
    }
    if (line.startsWith("exec 'find' ") && line.includes("/repos'"))
      return oneShotHandle(`${WORKER_ROOT}/repos/acme_demo.git${NUL}`, 0);
    if (line.startsWith("exec 'test' ")) return oneShotHandle("", state.cacheExists ? 0 : 1);
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
      if (line.includes("'status'"))
        return oneShotHandle(state.salvage === "clean" ? "" : " M src/index.ts\n", 0);
      if (line.includes("'commit'")) state.salvageCommitted = true;
      return oneShotHandle("", 0);
    }
    if (line.includes("exec 'git' '--git-dir'") && line.includes("'rev-parse'"))
      return oneShotHandle(`${COMMIT}\n`, 0);
    return oneShotHandle("", 0);
  };
  // Behaves like `ssh -N -L 127.0.0.1:<port>:127.0.0.1:<admin port> <gateway>`: prints its LocalCommand output once listening, then runs until dropped or killed.
  const startForward = Effect.fn("FakeMachine.startForward")(function* (command: StandardCommand) {
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
      const line = remoteLine(command);
      const input = yield* standardInput(command);
      if (command.args.includes("-N")) {
        state.calls.push({ command, line, input });
        return yield* startForward(command);
      }
      // Runs a `docker exec` line's command as if inside the container.
      if (line.startsWith("exec 'docker' 'exec' '-i' ")) {
        const [, , , container = "", , , inner = ""] = remoteWords(line);
        state.calls.push({ command, line: inner, input, container });
        return state.containers.has(container)
          ? respond(command, inner, input)
          : oneShotHandle("", 1, `Error response from daemon: No such container: ${container}`);
      }
      // Records `docker run` behind the pipe that gives it standard input as the docker command.
      const piped = `exec 'sh' '-c' ${quote('cat | "$@"')} 'sh' `;
      const direct = line.startsWith(piped)
        ? `exec ${remoteWords(line)
            .slice(4)
            .map((word) => quote(word))
            .join(" ")}`
        : line;
      state.calls.push({ command, line: direct, input });
      return respond(command, direct, input);
    }),
  );
  return { state, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service) };
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
        return new WorkerCredential({
          value: Redacted.make(token),
          expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + lifetimeMillis),
        });
      }),
  });
  return { minted, permissions, layer };
};

/** The bot account that commits in the fixture Attempts. */
export const COMMIT_AUTHOR = new BotAccount({
  login: BotLogin.make("usine-test[bot]"),
  id: BotUserId.make(4242),
});

/** The exports in a remote git command line that make `COMMIT_AUTHOR` its author and committer. */
export const BOT_COMMITS =
  "GIT_AUTHOR_NAME='usine-test[bot]' GIT_AUTHOR_EMAIL='4242+usine-test[bot]@users.noreply.github.com' GIT_COMMITTER_NAME='usine-test[bot]' GIT_COMMITTER_EMAIL='4242+usine-test[bot]@users.noreply.github.com'";

export const request = new CheckoutRequest({
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
  commitAuthor: COMMIT_AUTHOR,
});

/** A parent that fails the Attempt like a crash. */
export const fails: StubParent = () =>
  Effect.fail(new InfraFailure({ message: "The parent stopped", cause: new Error("crash") }));

/** Whether a remote command line writes an Attempt's token on the machine. */
export const writesCredential = (line: string) => line.includes("IFS= read -r token");

/** Returns a logger that collects every log message and its fields as text. */
export const capturedLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    lines.push(JSON.stringify(message));
  });
  return { lines, layer: Logger.layer([logger]) };
};

/** The test Worker's address, without a Gateway. */
export const ADDRESS: SshWorkerAddress = {
  name: WORKER,
  destination: DESTINATION,
  identityFile: Option.some(SshIdentityFile.make("~/.ssh/usine_worker")),
  port: Option.some(SshPort.make(2222)),
  root: WorkerRoot.make("/srv/usine"),
  gateway: Option.none(),
  container: {
    image: Option.none(),
    cpus: ContainerCpus.make(2),
    memoryMib: ContainerMemoryMib.make(4096),
    pids: ContainerPids.make(4096),
  },
};

/** The instance label of the test executor's containers. */
export const INSTANCE = "github-app-4242";

/** An HTTP client layer for a Worker without a Gateway; never called. */
const noGateway = Layer.succeed(
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
  probes: Pick<SshExecutorOptions, "harnessReadiness"> = {},
) =>
  sshLayer({ workers: [address], instance: INSTANCE, interruptGrace: "2 seconds", ...probes }).pipe(
    Layer.provide(machine.layer),
    Layer.provide(credentials.layer),
    Layer.provide(stubAttemptRuntime(storage, parent)),
    Layer.provide(claudeLoginLockLayer),
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
