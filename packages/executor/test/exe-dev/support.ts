import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { HarnessReadiness, HarnessReady } from "@usine/core/agent/capability";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSessionBudget,
  ParentSession,
  TextOutput,
  SessionTokensUpdated,
  TokenCount,
} from "@usine/core/agent/session";
import { AttemptTask, AttemptId } from "@usine/core/attempt";
import { SalvageRef } from "@usine/core/attempt/salvage";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { RepositoryName, CommitSha, RepositoryRevision } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { StepResult } from "@usine/core/step/result";
import { CheckoutRequest } from "../../src/executor.ts";
import { layer as exeDevLayer } from "../../src/exe-dev/exe-dev.ts";
import { GitHubIntegration, IntegrationName } from "../../src/exe-dev/model.ts";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { StandardCommand } from "effect/unstable/process/ChildProcess";

export const ATTEMPT_ID = AttemptId.make("remote-run/execute/1");
export const WORKER = WorkerName.make("remote-one");
const REPOSITORY = RepositoryName.make("acme/demo");
// The brand already rejects whitespace and a leading dash; the characters it
// still allows ($, ;, quotes) must die at the shell-quoting boundary.
const REVISION = RepositoryRevision.make("main;$(touch$IFS/tmp/usine-injected)");
const COMMIT = CommitSha.make("0123456789abcdef0123456789abcdef01234567");
export const SALVAGE_COMMIT = CommitSha.make("fedcba9876543210fedcba9876543210fedcba98");
const TASK = AttemptTask.make("Complete the remote task");
export const PROTOCOL = String(AttemptChannel.PROTOCOL_VERSION);
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
const TEST_SESSION = new ParentSession({
  id: AgentSessionId.make("parent-session"),
  agent: TEST_AGENT.name,
  brain: TEST_AGENT.brain,
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
const decodeInput = Schema.decodeUnknownEffect(AttemptChannel.InputFrameFromJson);
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(AttemptChannel.OutboundEnvelope));

type LaunchMode =
  | "token-limit"
  | "success"
  | "final-nonzero"
  | "wait-for-interrupt"
  | "ignore-interrupt";
type SweepMode = "valid" | "invalid-path";

interface FakeSshState {
  readonly commands: Array<StandardCommand>;
  readonly inputs: Array<AttemptChannel.InputFrame>;
  kills: number;
  /** When set, the next `rm -rf` on the Attempt worktree exits non-zero. */
  failWorktreeRm: boolean;
  readiness: HarnessReadiness;
  /** The simulated remote operation parks until its SSH client is killed. */
  hangPreparation:
    | "none"
    | "preflight"
    | "spawn"
    | "clone"
    | "fetch"
    | "attach"
    | "promotion"
    | "checkout";
  parked: boolean;
  failAttach: boolean;
  failStop: boolean;
  cacheExists: boolean;
  /** What the salvage finds in the worktree after an unsuccessful Attempt. */
  salvage: "clean" | "dirty" | "push-fails" | "inspect-fails" | "add-fails" | "commit-fails";
  salvageCommitted: boolean;
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

const hangingHandle = (state: FakeSshState) =>
  Effect.gen(function* () {
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
        Effect.sync(() => {
          state.kills += 1;
        }).pipe(
          Effect.andThen(
            Ref.set(running, false).pipe(
              Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(137))),
              Effect.asVoid,
            ),
          ),
        ),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  });

export const remoteArgs = (command: StandardCommand): ReadonlyArray<string> => {
  const separator = command.args.indexOf("--");
  return separator < 0 ? [] : command.args.slice(separator + 1);
};

const complete = <A>(deferred: Deferred.Deferred<A>, value: A, running: Ref.Ref<boolean>) =>
  Ref.set(running, false).pipe(Effect.andThen(Deferred.succeed(deferred, value)), Effect.asVoid);

const interactiveHandle = (command: StandardCommand, state: FakeSshState, mode: LaunchMode) =>
  Effect.gen(function* () {
    const output = yield* Queue.make<Uint8Array, Cause.Done>();
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const running = yield* Ref.make(true);
    const stdin = command.options.stdin;
    if (
      stdin === undefined ||
      stdin === "pipe" ||
      stdin === "inherit" ||
      stdin === "ignore" ||
      stdin === "overlapped" ||
      Stream.isStream(stdin)
    ) {
      return yield* Effect.die("the SSH launch did not carry a framed input stream");
    }
    if (!Stream.isStream(stdin.stream)) {
      return yield* Effect.die("the SSH launch configured a string stdin mode");
    }

    const emit = (envelope: AttemptChannel.OutboundEnvelope) =>
      Queue.offer(output, encoder.encode(`${encodeOutput(envelope)}\n`));
    yield* stdin.stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const input = yield* decodeInput(line);
          state.inputs.push(input);
          if (input._tag === "Start") {
            yield* emit(
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId: input.spec.attemptId,
                sequence: AttemptChannel.Sequence.make(1),
                sentAt: DateTime.makeUnsafe("2026-08-31T12:00:00Z"),
                payload: new AttemptChannel.Started({
                  parentModel: TEST_SESSION.brain.model,
                }),
              }),
            );
            if (mode === "token-limit")
              yield* emit(
                new AttemptChannel.OutboundEnvelope({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId: input.spec.attemptId,
                  sequence: AttemptChannel.Sequence.make(2),
                  sentAt: DateTime.makeUnsafe("2026-08-31T12:00:01Z"),
                  payload: new AttemptChannel.SessionEvent({
                    event: new SessionTokensUpdated({
                      session: TEST_SESSION,
                      totalTokens: TokenCount.make(10_000_000),
                    }),
                  }),
                }),
              );
            if (mode === "success" || mode === "final-nonzero") {
              yield* emit(
                new AttemptChannel.OutboundEnvelope({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId: input.spec.attemptId,
                  sequence: AttemptChannel.Sequence.make(2),
                  sentAt: DateTime.makeUnsafe("2026-08-31T12:00:01Z"),
                  payload: new AttemptChannel.SessionEvent({
                    event: new TextOutput({
                      session: TEST_SESSION,
                      text: "Remote work completed",
                    }),
                  }),
                }),
              );
              yield* emit(
                new AttemptChannel.OutboundEnvelope({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId: input.spec.attemptId,
                  sequence: AttemptChannel.Sequence.make(3),
                  sentAt: DateTime.makeUnsafe("2026-08-31T12:00:02Z"),
                  payload: new AttemptChannel.Final({
                    result: new StepResult({ message: "done", facts: [] }),
                  }),
                }),
              );
              yield* Queue.end(output);
              yield* complete(
                exit,
                ChildProcessSpawner.ExitCode(mode === "success" ? 0 : 17),
                running,
              );
            }
            return;
          }
          if (
            input.payload._tag === "Cancel" &&
            (mode === "wait-for-interrupt" || mode === "token-limit")
          ) {
            yield* emit(
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId: input.attemptId,
                sequence: AttemptChannel.Sequence.make(mode === "token-limit" ? 3 : 2),
                sentAt: DateTime.makeUnsafe("2026-08-31T12:00:03Z"),
                payload: new AttemptChannel.Interrupted(),
              }),
            );
            yield* Queue.end(output);
            yield* complete(exit, ChildProcessSpawner.ExitCode(0), running);
          }
        }),
      ),
      Effect.forkScoped,
    );

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(2),
      stdin: Sink.drain,
      stdout: Stream.fromQueue(output),
      stderr: Stream.empty,
      all: Stream.fromQueue(output),
      exitCode: Deferred.await(exit),
      isRunning: Ref.get(running),
      kill: () =>
        Effect.sync(() => {
          state.kills += 1;
        }).pipe(
          Effect.andThen(Queue.end(output)),
          Effect.andThen(complete(exit, ChildProcessSpawner.ExitCode(137), running)),
        ),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  });

export const fakeSsh = (
  protocol: string,
  mode: LaunchMode = "success",
  sweepMode: SweepMode = "valid",
) => {
  const state: FakeSshState = {
    commands: [],
    inputs: [],
    kills: 0,
    failWorktreeRm: false,
    readiness: new HarnessReady({ harness: "claude" }),
    hangPreparation: "none",
    parked: false,
    failAttach: false,
    failStop: false,
    cacheExists: false,
    salvage: "clean",
    salvageCommitted: false,
  };
  const service = ChildProcessSpawner.make(
    Effect.fn("FakeSsh.spawn")(function* (command) {
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
      state.commands.push(command);
      const remote = remoteArgs(command);
      const remoteLine = remote[0] ?? "";
      if (state.failStop && remoteLine.startsWith("exec 'sh' '-c'")) {
        return oneShotHandle("", 255, "remote stop request lost");
      }
      if (state.failAttach && command.args.includes("attach"))
        return oneShotHandle("", 255, "lost reply after attachment");
      if (remoteLine.startsWith("exec 'mv' ")) state.cacheExists = true;
      if (
        (state.hangPreparation === "preflight" && remoteLine.includes("--preflight")) ||
        (state.hangPreparation === "clone" && remoteLine.includes("'clone'")) ||
        (state.hangPreparation === "fetch" && remoteLine.includes("'fetch'")) ||
        (state.hangPreparation === "attach" && command.args.includes("attach")) ||
        (state.hangPreparation === "promotion" && remoteLine.startsWith("exec 'mv' ")) ||
        (state.hangPreparation === "checkout" && remoteLine.includes("'worktree' 'add'"))
      ) {
        state.parked = true;
        return yield* hangingHandle(state);
      }
      if (
        state.failWorktreeRm &&
        remoteLine.startsWith("exec 'rm' '-rf'") &&
        remoteLine.includes("/attempts/remote-run_execute_1'")
      ) {
        return oneShotHandle("", 1, "rm: cannot remove: device or resource busy");
      }
      if (remoteLine.includes("&& export GH_HOST=github.int.exe.xyz &&")) {
        if (state.hangPreparation === "spawn") {
          state.parked = true;
          return yield* Effect.never;
        }
        return yield* interactiveHandle(command, state, mode);
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
      if (remoteLine === "exec 'printenv' 'HOME'") return oneShotHandle("/home/exedev\n", 0);
      if (remoteLine === "exec 'git' '--version'") {
        return oneShotHandle("git version 2.50.1\n", 0);
      }
      if (remoteLine === "exec 'node' '--version'") {
        return oneShotHandle("v22.18.0\n", 0);
      }
      if (remoteLine === "exec 'usine-run-host' '--protocol-version'") {
        return oneShotHandle(`${protocol}\n`, 0);
      }
      if (remoteLine.startsWith("exec 'usine-run-host' '--preflight'")) {
        return oneShotHandle(
          Schema.encodeSync(Schema.fromJsonString(HarnessReadiness))(state.readiness),
          0,
        );
      }
      if (remoteLine.startsWith("exec 'find' ") && remoteLine.includes("/attempts'")) {
        return oneShotHandle(
          sweepMode === "valid"
            ? "/home/exedev/.usine/workers/remote-one/attempts/abandoned-attempt\0"
            : "/tmp/not-a-worker-child\0",
          0,
        );
      }
      if (remoteLine.startsWith("exec 'find' ") && remoteLine.includes("/repos'")) {
        return oneShotHandle("/home/exedev/.usine/workers/remote-one/repos/acme_demo.git\0", 0);
      }
      if (remoteLine.startsWith("exec 'test' "))
        return oneShotHandle("", state.cacheExists ? 0 : 1);
      if (remoteLine.startsWith("exec 'git' '-C' ")) {
        if (remoteLine.includes("'rev-parse'")) {
          return oneShotHandle(`${state.salvageCommitted ? SALVAGE_COMMIT : COMMIT}\n`, 0);
        }
        if (remoteLine.includes("'status'")) {
          if (state.salvage === "inspect-fails") return oneShotHandle("", 128, "inspection failed");
          return oneShotHandle(state.salvage === "clean" ? "" : " M src/index.ts\n", 0);
        }
        if (remoteLine.includes("'add'") && state.salvage === "add-fails")
          return oneShotHandle("", 128, "index.lock exists");
        if (remoteLine.includes("'commit'")) {
          if (state.salvage === "commit-fails") return oneShotHandle("", 128, "commit failed");
          state.salvageCommitted = true;
          return oneShotHandle("", 0);
        }
        if (remoteLine.includes("'push'") && state.salvage === "push-fails") {
          return oneShotHandle("", 128, "remote: permission denied");
        }
        return oneShotHandle("", 0);
      }
      if (remoteLine.includes("'git' '--git-dir'") && remoteLine.includes("'rev-parse'")) {
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

export const runtime = (sshLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  exeDevLayer({
    githubIntegrations: [integration],
    // The cancellation tests advance the TestClock by exactly this much.
    interruptGrace: "2 seconds",
  }).pipe(Layer.provide(sshLayer));
