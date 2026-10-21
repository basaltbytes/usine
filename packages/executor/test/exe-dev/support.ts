import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptTask, AttemptId, AttemptWindow, AttemptWindows } from "@usine/core/attempt";
import { InfraFailure } from "@usine/core/attempt/failure";
import { SalvageRef } from "@usine/core/attempt/salvage";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, CommitSha, RepositoryRevision } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import type { AttemptRuntime } from "@usine/durable/attempt-runtime";
import {
  completes,
  type StubParent,
  stubAttemptRuntime,
  StubStorage,
} from "@usine/durable/testing";
import { CheckoutRequest, claudeLoginLockLayer } from "../../src/executor.ts";
import { layer as exeDevLayer } from "../../src/exe-dev/exe-dev.ts";
import { GitHubIntegration, IntegrationName } from "../../src/exe-dev/model.ts";
import { DateTime, Deferred, Effect, Layer, Option, Ref, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { StandardCommand } from "effect/unstable/process/ChildProcess";

export const ATTEMPT_ID = AttemptId.make("remote-run/execute/1");

/**
 * Reads the windows of `attemptId` running alone on its Run's Item: its own,
 * open since before any time a test clock or GitHub fixture gives, and no
 * other Attempt of its Agent there, so the harvest keeps every signed comment.
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
export const WORKER = WorkerName.make("remote-one");
const REPOSITORY = RepositoryName.make("acme/demo");
// The brand already rejects whitespace and a leading dash; the characters it
// still allows ($, ;, quotes) must die at the shell-quoting boundary.
const REVISION = RepositoryRevision.make("main;$(touch$IFS/tmp/usine-injected)");
const COMMIT = CommitSha.make("0123456789abcdef0123456789abcdef01234567");
export const SALVAGE_COMMIT = CommitSha.make("fedcba9876543210fedcba9876543210fedcba98");
const TASK = AttemptTask.make("Complete the remote task");
export const WORKTREE = "/home/exedev/.usine/workers/remote-one/attempts/remote-run_execute_1";
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
const INTEGRATION = IntegrationName.make("usine-acme-demo");
const encoder = new TextEncoder();
export const SSH_ENVIRONMENT_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
  "TMPDIR",
  "USER",
]);

type SweepMode = "valid" | "invalid-path";

interface FakeSshState {
  readonly commands: Array<StandardCommand>;
  /** When set, the next `rm -rf` on the Attempt worktree exits non-zero. */
  failWorktreeRm: boolean;
  /** Whether the VM's Claude Code reports a subscription login. */
  claudeLoggedIn: boolean;
  /** The simulated remote operation parks until its SSH client is killed. */
  hangPreparation: "none" | "preflight" | "clone" | "fetch" | "attach" | "promotion" | "checkout";
  parked: boolean;
  failAttach: boolean;
  failStop: boolean;
  cacheExists: boolean;
  /** The Attempt's worktree was removed from the VM behind the executor's back. */
  worktreeGone: boolean;
  /** What the salvage finds in the worktree after an unsuccessful Attempt. */
  salvage: "clean" | "dirty" | "push-fails" | "inspect-fails" | "add-fails" | "commit-fails";
  salvageCommitted: boolean;
  resumeFailure?: "lookup" | "fetch" | "decode";
  /** GitHub's `--slurp` pages for the conversation comments of Item 42. */
  issueComments: string;
  /** Runs each time `gh` lists the conversation comments of Item 42, before it answers. */
  onIssueComments: () => void;
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

const hangingHandle = Effect.gen(function* () {
  const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const running = yield* Ref.make(true);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(3),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Deferred.await(exit),
    isRunning: Ref.get(running),
    kill: () =>
      Ref.set(running, false).pipe(
        Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(137))),
        Effect.asVoid,
      ),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
});

/** The single remote command line an SSH invocation carries after `--`. */
export const remoteLine = (command: StandardCommand): string => {
  const separator = command.args.indexOf("--");
  return separator < 0 ? "" : (command.args[separator + 1] ?? "");
};

/** Fakes the local SSH client: the exe.dev lobby and every command on the Worker's VM. */
export const fakeSsh = (sweepMode: SweepMode = "valid") => {
  const state: FakeSshState = {
    commands: [],
    failWorktreeRm: false,
    claudeLoggedIn: true,
    hangPreparation: "none",
    parked: false,
    failAttach: false,
    failStop: false,
    cacheExists: false,
    worktreeGone: false,
    salvage: "clean",
    salvageCommitted: false,
    issueComments: "[[]]",
    onIssueComments: () => {},
  };
  const service = ChildProcessSpawner.make(
    Effect.fn("FakeSsh.spawn")(function* (command) {
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
      state.commands.push(command);
      const line = remoteLine(command);
      if (state.failStop && line.startsWith("exec 'sh' '-c'")) {
        return oneShotHandle("", 255, "remote stop request lost");
      }
      if (state.failAttach && command.args.includes("attach"))
        return oneShotHandle("", 255, "lost reply after attachment");
      if (line.startsWith("exec 'mv' ")) state.cacheExists = true;
      if (
        (state.hangPreparation === "preflight" && line.startsWith("exec 'claude'")) ||
        (state.hangPreparation === "clone" && line.includes("'clone'")) ||
        (state.hangPreparation === "fetch" && line.includes("'fetch'")) ||
        (state.hangPreparation === "attach" && command.args.includes("attach")) ||
        (state.hangPreparation === "promotion" && line.startsWith("exec 'mv' ")) ||
        (state.hangPreparation === "checkout" && line.includes("'worktree' 'add'"))
      ) {
        state.parked = true;
        return yield* hangingHandle;
      }
      if (
        state.failWorktreeRm &&
        line.startsWith("exec 'rm' '-rf'") &&
        line.includes("/attempts/remote-run_execute_1'")
      ) {
        return oneShotHandle("", 1, "rm: cannot remove: device or resource busy");
      }
      if (command.args.includes("exe.dev") && command.args.includes("ls")) {
        return oneShotHandle(
          JSON.stringify({
            vms: [
              {
                vm_name: WORKER,
                ssh_dest: `${WORKER}.exe.xyz`,
                status: "running",
                region: "fra",
              },
            ],
          }),
          0,
        );
      }
      if (line === "exec 'printenv' 'HOME'") return oneShotHandle("/home/exedev\n", 0);
      if (line === "exec 'git' '--version'") {
        return oneShotHandle("git version 2.50.1\n", 0);
      }
      if (line === "exec 'cat' '/proc/meminfo'")
        return oneShotHandle("MemTotal:        8074035 kB\nSwapTotal:       2097148 kB\n", 0);
      if (line === "exec 'claude' '--version'") return oneShotHandle("2.1.296 (Claude Code)\n", 0);
      if (line === "exec 'claude' 'auth' 'status' '--json'") {
        return oneShotHandle(
          JSON.stringify({
            loggedIn: state.claudeLoggedIn,
            authMethod: state.claudeLoggedIn ? "claude.ai" : "none",
            apiProvider: "firstParty",
          }),
          state.claudeLoggedIn ? 0 : 1,
        );
      }
      if (line.startsWith("exec 'sh' '-c'")) return oneShotHandle("no-children\n", 0);
      if (line.includes("&& exec 'gh' 'api' 'repos/acme/demo/issues/42/comments?")) {
        state.onIssueComments();
        return oneShotHandle(state.issueComments, 0);
      }
      // Harvest: no new commits and an unchanged detached HEAD.
      if (line.startsWith("cd ") && line.includes("&& exec 'git' 'log'"))
        return oneShotHandle("", 0);
      if (line.startsWith("cd ") && line.includes("&& exec 'git' 'rev-parse' 'HEAD'"))
        return oneShotHandle(`${COMMIT}\n`, 0);
      if (line.startsWith("cd ") && line.includes("&& exec 'git' 'branch' '--show-current'"))
        return oneShotHandle("", 0);
      if (line.startsWith("exec 'find' ") && line.includes("/attempts'")) {
        if (sweepMode !== "valid") return oneShotHandle("/tmp/not-a-worker-child\0", 0);
        const attemptsRoot = "/home/exedev/.usine/workers/remote-one/attempts";
        // The Attempt's checkout is listed exactly when `test -d` would find it.
        const listed = state.cacheExists
          ? [`${attemptsRoot}/abandoned-attempt`, `${attemptsRoot}/remote-run_execute_1`]
          : [`${attemptsRoot}/abandoned-attempt`];
        return oneShotHandle(listed.map((entry) => `${entry}\0`).join(""), 0);
      }
      if (line.startsWith("exec 'find' ") && line.includes("/repos'")) {
        return oneShotHandle("/home/exedev/.usine/workers/remote-one/repos/acme_demo.git\0", 0);
      }
      if (line.startsWith("exec 'test' "))
        return oneShotHandle(
          "",
          state.cacheExists && !(state.worktreeGone && line.includes(WORKTREE)) ? 0 : 1,
        );
      if (line.startsWith("exec 'git' '-C' ")) {
        if (line.includes("'--absolute-git-dir'"))
          return oneShotHandle(
            "/home/exedev/.usine/workers/remote-one/repos/acme_demo.git/worktrees/remote-run_execute_1\n",
            0,
          );
        if (line.includes("'rev-parse'")) {
          return oneShotHandle(`${state.salvageCommitted ? SALVAGE_COMMIT : COMMIT}\n`, 0);
        }
        if (line.includes("'status'")) {
          if (state.salvage === "inspect-fails") return oneShotHandle("", 128, "inspection failed");
          return oneShotHandle(state.salvage === "clean" ? "" : " M src/index.ts\n", 0);
        }
        if (line.includes("'add'") && state.salvage === "add-fails")
          return oneShotHandle("", 128, "index.lock exists");
        if (line.includes("'commit'")) {
          if (state.salvage === "commit-fails") return oneShotHandle("", 128, "commit failed");
          state.salvageCommitted = true;
          return oneShotHandle("", 0);
        }
        if (line.includes("'push'") && state.salvage === "push-fails") {
          return oneShotHandle("", 128, "remote: permission denied");
        }
        return oneShotHandle("", 0);
      }
      if (line.includes("'ls-remote'")) {
        if (state.resumeFailure === "lookup") return oneShotHandle("", 128, "HTTP 503");
        return oneShotHandle(`${COMMIT}\trefs/heads/usine/salvage/r/1\n`, 0);
      }
      if (line.includes("'fetch'") && line.includes("refs/heads/usine/salvage/")) {
        if (state.resumeFailure === "fetch") return oneShotHandle("", 128, "HTTP 503");
        state.salvageCommitted = true;
      }
      if (line.includes("'git' '--git-dir'") && line.includes("'rev-parse'")) {
        if (state.resumeFailure === "decode" && state.salvageCommitted)
          return oneShotHandle("invalid\n", 0);
        return oneShotHandle(`${COMMIT}\n`, 0);
      }
      return oneShotHandle("{}\n", 0);
    }),
  );
  return {
    state,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, service),
  };
};

const integration = new GitHubIntegration({ repository: REPOSITORY, name: INTEGRATION });

export const request = new CheckoutRequest({
  attemptId: ATTEMPT_ID,
  worker: WORKER,
  repository: REPOSITORY,
  loop: LoopName.make("implement"),
  permissions: "write",
  revision: REVISION,
  payload: { issue: { number: 42 } },
  task: TASK,
  agent: TEST_AGENT,
  parentModel: Option.none(),
  maxChildren: ChildSessionBudget.make(4),
  maxAttemptMinutes: Option.some(60),
  maxAttemptTokens: Option.some(10_000_000),
  parentEffort: "high",
  salvageRef: SalvageRef.make("usine/salvage/remote-run/1"),
  resume: Option.none(),
});

/** Fails the Attempt the way a crashed parent does. */
export const fails: StubParent = () =>
  Effect.fail(new InfraFailure({ message: "The parent stopped", cause: new Error("crash") }));

/**
 * The exe.dev executor over the fake SSH client, with each Attempt's parent
 * scripted by `parent` on `storage`. Build it again on the same storage to
 * simulate an orchestrator restart.
 */
export const runtime = (
  sshLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  parent: StubParent = completes,
  storage: StubStorage = new StubStorage(),
  /** Wraps the stub runtime, for tests that hold one of its durable operations open. */
  wrap: (stub: Layer.Layer<AttemptRuntime>) => Layer.Layer<AttemptRuntime> = (stub) => stub,
) =>
  exeDevLayer({
    githubIntegrations: [integration],
    // The cancellation tests advance the TestClock by exactly this much.
    interruptGrace: "2 seconds",
  }).pipe(
    Layer.provide(sshLayer),
    Layer.provide(wrap(stubAttemptRuntime(storage, parent))),
    Layer.provide(claudeLoginLockLayer),
  );
