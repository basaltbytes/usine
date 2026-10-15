import { CHILD_KILL_SCRIPT } from "@usine/agents/child-host";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptTask, AttemptId } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import { SalvageRef } from "@usine/core/attempt/salvage";
import { RepositoryName, CommitSha, RepositoryRevision } from "@usine/core/repository";
import {
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
import { Clock, DateTime, Effect, Layer, Logger, Option, Redacted, Sink, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { StandardCommand } from "effect/unstable/process/ChildProcess";
import { CheckoutRequest, CredentialProvider, WorkerCredential } from "../../src/executor.ts";
import {
  layer as sshLayer,
  type SshExecutorOptions,
  type SshWorkerAddress,
} from "../../src/ssh/ssh.ts";

const ATTEMPT_ID = AttemptId.make("remote-run/execute/1");
export const WORKER = WorkerName.make("eu-one");
export const DESTINATION = SshDestination.make("usine@203.0.113.7");
const REPOSITORY = RepositoryName.make("acme/demo");
const COMMIT = CommitSha.make("0123456789abcdef0123456789abcdef01234567");
const SALVAGE_COMMIT = CommitSha.make("fedcba9876543210fedcba9876543210fedcba98");
export const WORKER_ROOT = "/srv/usine/workers/eu-one";
export const WORKTREE = `${WORKER_ROOT}/attempts/remote-run_execute_1`;
export const CREDENTIALS = `${WORKER_ROOT}/credentials/remote-run_execute_1`;
/** Every token the fake provider mints starts with this, so a leak is found by substring. */
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

/** One remote command, with the standard input the executor sent it. */
interface RemoteCall {
  readonly command: StandardCommand;
  readonly line: string;
  readonly input: string;
}

interface FakeMachineState {
  readonly calls: Array<RemoteCall>;
  /** The credential directories on the machine and the token each one contains. */
  readonly credentials: Map<string, string>;
  reachable: boolean;
  rootWritable: boolean;
  cacheExists: boolean;
  /** A failing clone whose stderr echoes the token git authenticated with. */
  cloneEchoesToken: boolean;
  salvage: "clean" | "dirty";
  salvageCommitted: boolean;
  claudeLoggedIn: boolean;
  /** Whether sshd accepts the variables the SSH client sends (`AcceptEnv`). */
  acceptsSentVariables: boolean;
  readonly droppedSentVariables: Set<string>;
  /** Whether `git.<domain>` resolves and answers from the machine. */
  gatewayReachable: boolean;
  /** Whether the Gateway's forward proxy answers the machine at all. */
  forwardProxyReachable: boolean;
  /** Hosts the Gateway's forward proxy refuses to open a tunnel to. */
  readonly refusedHosts: Set<string>;
  /** gh's configuration files written on the machine, by path. */
  readonly files: Map<string, string>;
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

/** The single remote command line an SSH invocation passes after `--`. */
const remoteLine = (command: StandardCommand): string => {
  const separator = command.args.indexOf("--");
  return separator < 0 ? "" : (command.args[separator + 1] ?? "");
};

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

/** The quoted words of a remote command line, unquoted: `exec 'sh' '-c' ...` gives `sh`, `-c`, .... */
const remoteWords = (line: string): Array<string> =>
  [...line.matchAll(/'((?:[^']|'"'"')*)'/gu)].map(([, word]) =>
    (word ?? "").replaceAll(`'"'"'`, "'"),
  );

/** The variables an SSH invocation sends to the machine and has a value for in its own environment. */
export const sentVariables = (command: StandardCommand): Array<string> => {
  const option = command.args.find((arg) => arg.startsWith("SendEnv="));
  const names = option === undefined ? [] : option.slice("SendEnv=".length).split(" ");
  return names.filter((name) => command.options.env?.[name] !== undefined);
};

/** The remote line that stops the Attempt's children before its checkout is kept or removed. */
export const KILL_CHILDREN = `exec 'sh' '-c' ${quote(CHILD_KILL_SCRIPT)} 'sh' '${WORKTREE}'`;

/** The bytes the executor streams to a command's standard input, decoded. */
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

/** Fakes the local SSH client and the Linux machine every SSH Worker command runs on. */
export const fakeMachine = () => {
  const state: FakeMachineState = {
    calls: [],
    credentials: new Map(),
    reachable: true,
    rootWritable: true,
    cacheExists: false,
    cloneEchoesToken: false,
    salvage: "clean",
    salvageCommitted: false,
    claudeLoggedIn: true,
    acceptsSentVariables: true,
    droppedSentVariables: new Set(),
    gatewayReachable: true,
    forwardProxyReachable: true,
    refusedHosts: new Set(),
    files: new Map(),
  };
  const respond = (command: StandardCommand, line: string, input: string) => {
    if (!state.reachable)
      return oneShotHandle(
        "",
        255,
        "ssh: connect to host 203.0.113.7 port 2222: Connection refused",
      );
    if (line === "exec 'true'") return oneShotHandle("", 0);
    if (line.includes("printenv")) {
      const received = state.acceptsSentVariables
        ? sentVariables(command).filter((name) => !state.droppedSentVariables.has(name))
        : [];
      const expected = remoteWords(line).slice(4);
      const dropped = expected.filter((word, index) => index % 2 === 0 && !received.includes(word));
      return oneShotHandle(dropped.map((name) => `${name}\n`).join(""), 0);
    }
    // Answers the login host check as curl through the forward proxy does: the CONNECT status, then the host's own.
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
    if (line.includes("http_unix_socket")) {
      const [directory, config, hosts] = remoteWords(line).slice(-3);
      state.files.set(`${directory}/config.yml`, config ?? "");
      state.files.set(`${directory}/hosts.yml`, hosts ?? "");
      return oneShotHandle("", 0);
    }
    if (line.includes("IFS= read -r token")) {
      const directory = line.slice(line.lastIndexOf(" '") + 2, -1);
      state.credentials.set(directory, input.split("\n")[0] ?? "");
      return oneShotHandle("", 0);
    }
    if (line.includes("test -d") && line.includes("test -w"))
      return oneShotHandle("", state.rootWritable ? 0 : 1);
    if (line.includes("pidfile")) return oneShotHandle("no-children\n", 0);
    if (line.startsWith("exec 'rm' '-rf' ")) {
      const target = line.slice("exec 'rm' '-rf' '".length, -1);
      for (const directory of state.credentials.keys())
        if (directory === target || directory.startsWith(`${target}/`))
          state.credentials.delete(directory);
      return oneShotHandle("", 0);
    }
    if (line === "exec 'git' '--version'") return oneShotHandle("git version 2.47.3\n", 0);
    if (line === "exec 'claude' '--version'") return oneShotHandle("2.1.296 (Claude Code)\n", 0);
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
  const service = ChildProcessSpawner.make(
    Effect.fn("FakeMachine.spawn")(function* (command) {
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
      const line = remoteLine(command);
      const input = yield* standardInput(command);
      state.calls.push({ command, line, input });
      return respond(command, line, input);
    }),
  );
  return { state, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service) };
};

/** Mints a distinct one-hour token on each request, as the GitHub App does. */
export const mintingProvider = (lifetimeMillis = 3_600_000) => {
  const minted: Array<string> = [];
  const layer = Layer.succeed(CredentialProvider)({
    issue: () =>
      Effect.gen(function* () {
        const token = `${TOKEN_PREFIX}${minted.length + 1}`;
        minted.push(token);
        return new WorkerCredential({
          value: Redacted.make(token),
          expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + lifetimeMillis),
        });
      }),
  });
  return { minted, layer };
};

export const request = new CheckoutRequest({
  attemptId: ATTEMPT_ID,
  worker: WORKER,
  repository: REPOSITORY,
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
});

/** Fails the Attempt the way a crashed parent does. */
export const fails: StubParent = () =>
  Effect.fail(new InfraFailure({ message: "The parent stopped", cause: new Error("crash") }));

/** Whether a remote command line writes an Attempt's token on the machine. */
export const writesCredential = (line: string) => line.includes("IFS= read -r token");

/** Collects every log message and its fields as text. */
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
};

/** An HTTP client for a Worker without a Gateway, which never calls one. */
const noGateway = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die(new Error("A Worker without a Gateway made an HTTP request"))),
);

/**
 * The SSH executor for `address` on the fake machine, with each Attempt's
 * parent scripted by `parent` and its tokens minted by `credentials`; the
 * caller provides the HTTP client its Gateway's admin API is reached with.
 */
export const executorLayer = (
  machine: ReturnType<typeof fakeMachine>,
  credentials: ReturnType<typeof mintingProvider>,
  address: SshWorkerAddress,
  parent: StubParent = completes,
  /** Build again on the same storage to simulate an orchestrator restart. */
  storage: StubStorage = new StubStorage(),
  /** Replaces the executor's own login and binary checks. */
  probes: Pick<SshExecutorOptions, "harnessReadiness"> = {},
) =>
  sshLayer({ workers: [address], interruptGrace: "2 seconds", ...probes }).pipe(
    Layer.provide(machine.layer),
    Layer.provide(credentials.layer),
    Layer.provide(stubAttemptRuntime(storage, parent)),
  );

/**
 * The SSH executor for one Worker without a Gateway on the fake machine, with
 * each Attempt's parent scripted by `parent` and its tokens minted by
 * `credentials`.
 */
export const runtime = (
  machine: ReturnType<typeof fakeMachine>,
  credentials: ReturnType<typeof mintingProvider>,
  parent: StubParent = completes,
  /** Build again on the same storage to simulate an orchestrator restart. */
  storage: StubStorage = new StubStorage(),
) => executorLayer(machine, credentials, ADDRESS, parent, storage).pipe(Layer.provide(noGateway));
