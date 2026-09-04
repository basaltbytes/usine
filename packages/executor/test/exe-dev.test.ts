import { assert, describe, it } from "@effect/vitest";
import { Agent, Attempt, AttemptChannel, Repository, StepResult, Worker } from "@usine/core";
import { CheckoutRequest, Executor, type PreparedAttempt } from "../src/index.ts";
import {
  GitHubIntegration,
  HarnessLoginCheck,
  IntegrationName,
  layer as exeDevLayer,
} from "../src/exe-dev/index.ts";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Result,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { StandardCommand } from "effect/unstable/process/ChildProcess";
import { TestClock } from "effect/testing";

const ATTEMPT_ID = Attempt.AttemptId.make("remote-run/execute/1");
const WORKER = Worker.Name.make("remote-one");
const REPOSITORY = Repository.Name.make("acme/demo");
// The brand already rejects whitespace and a leading dash; what remains
// representable ($, ;, quotes) must still die at the shell-quoting boundary.
const REVISION = Repository.Revision.make("main;$(touch$IFS/tmp/usine-injected)");
const COMMIT = Repository.CommitSha.make("0123456789abcdef0123456789abcdef01234567");
const TASK = AttemptChannel.Task.make("Complete the remote task");
const PROTOCOL = String(AttemptChannel.PROTOCOL_VERSION);
const TEST_AGENT = new Agent.Agent({
  name: Agent.Name.make("developer"),
  brain: new Agent.BrainSpec({
    harness: "claude",
    model: Agent.ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: Agent.Persona.make("Implement the task."),
});
const TEST_SESSION = new Agent.ParentSession({
  id: Agent.SessionId.make("parent-session"),
  agent: TEST_AGENT.name,
  brain: TEST_AGENT.brain,
});
const INTEGRATION = IntegrationName.make("usine-acme-demo");
const encoder = new TextEncoder();
const SSH_ENVIRONMENT_ALLOWLIST = new Set([
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

type LaunchMode = "success" | "final-nonzero" | "wait-for-interrupt" | "ignore-interrupt";
type SweepMode = "valid" | "invalid-path";

interface FakeSshState {
  readonly commands: Array<StandardCommand>;
  readonly inputs: Array<AttemptChannel.InputFrame>;
  kills: number;
  /** When set, the next `rm -rf` on the Attempt worktree exits non-zero. */
  failWorktreeRm: boolean;
  /** When set, `git clone` parks until killed, so a test can interrupt prepare. */
  hangClone: boolean;
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

const remoteArgs = (command: StandardCommand): ReadonlyArray<string> => {
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
            if (mode === "success" || mode === "final-nonzero") {
              yield* emit(
                new AttemptChannel.OutboundEnvelope({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId: input.spec.attemptId,
                  sequence: AttemptChannel.Sequence.make(2),
                  sentAt: DateTime.makeUnsafe("2026-08-31T12:00:01Z"),
                  payload: new AttemptChannel.SessionEvent({
                    event: new Agent.TextOutput({
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
                    result: new StepResult.StepResult({ message: "done", facts: [] }),
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
          if (input.payload._tag === "Interrupt" && mode === "wait-for-interrupt") {
            yield* emit(
              new AttemptChannel.OutboundEnvelope({
                version: AttemptChannel.PROTOCOL_VERSION,
                attemptId: input.attemptId,
                sequence: AttemptChannel.Sequence.make(2),
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

const fakeSsh = (
  protocol: string,
  mode: LaunchMode = "success",
  sweepMode: SweepMode = "valid",
) => {
  const state: FakeSshState = {
    commands: [],
    inputs: [],
    kills: 0,
    failWorktreeRm: false,
    hangClone: false,
  };
  const service = ChildProcessSpawner.make(
    Effect.fn("FakeSsh.spawn")(function* (command) {
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
      state.commands.push(command);
      const remote = remoteArgs(command);
      const remoteLine = remote[0] ?? "";
      if (state.hangClone && remoteLine.includes("'clone'")) {
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
      if (remoteLine.startsWith("exec 'test' ")) return oneShotHandle("", 1);
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
const harness = new HarnessLoginCheck({
  harness: "codex",
  command: "codex",
  args: ["login", "status"],
});

const request = new CheckoutRequest({
  attemptId: ATTEMPT_ID,
  worker: WORKER,
  repository: REPOSITORY,
  revision: REVISION,
  payload: { issue: { number: 42 } },
  task: TASK,
  agent: TEST_AGENT,
  parentModel: Option.none(),
  maxChildren: Agent.ChildSessionBudget.make(4),
  parentEffort: "high",
});

const runtime = (sshLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  exeDevLayer({
    githubIntegrations: [integration],
    harnessLoginChecks: [harness],
    // Pinned: the cancellation tests advance the TestClock by exactly this.
    interruptGrace: "2 seconds",
  }).pipe(Layer.provide(sshLayer));

describe("exe.dev executor", () => {
  it.effect("preflight verifies the baked VM without changing remote state", () => {
    const ssh = fakeSsh(PROTOCOL);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER);
      for (const command of ssh.state.commands) {
        const remoteLine = remoteArgs(command)[0] ?? "";
        for (const mutating of [
          "attach",
          "clone",
          "detach",
          "find",
          "mkdir",
          "mv",
          "prune",
          "rm",
        ]) {
          assert(
            !command.args.includes(mutating) && !remoteLine.includes(`'${mutating}'`),
            `preflight invoked ${mutating}`,
          );
        }
      }
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("contains an invalid sweep boundary without touching it or blocking prepare", () => {
    const ssh = fakeSsh(PROTOCOL, "success", "invalid-path");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER);
      // The sweep failure is isolated: prepare proceeds, but the path outside
      // the Worker root is never acted on.
      const prepared = yield* executor.prepare(request);
      assert.strictEqual(prepared.spec.attemptId, ATTEMPT_ID);
      assert.deepStrictEqual(prepared.spec.payload, request.payload);
      assert.deepStrictEqual(prepared.spec.agent, request.agent);
      assert.deepStrictEqual(prepared.spec.parentModel, request.parentModel);
      const commandLine = ssh.state.commands.map(({ args }) => args.join(" ")).join("\n");
      assert(!commandLine.includes("/tmp/not-a-worker-child"));
      assert(commandLine.includes("integrations attach"));
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("drops the prepared state exactly once when cleanup partially fails", () => {
    const ssh = fakeSsh(PROTOCOL);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER);
      const prepared = yield* executor.prepare(request);
      ssh.state.failWorktreeRm = true;
      const error = yield* executor.cleanup(prepared).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ExecutorOperationError");
      const detaches = () =>
        ssh.state.commands.filter(({ args }) => args.join(" ").includes("integrations detach"))
          .length;
      // The grant released once despite the worktree failure...
      assert.strictEqual(detaches(), 1);
      const issued = ssh.state.commands.length;
      // ...and the second cleanup is a recorded no-op, not a second release
      // that would detach a running sibling's credentials.
      yield* executor.cleanup(prepared);
      assert.strictEqual(detaches(), 1);
      assert.strictEqual(ssh.state.commands.length, issued);
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("releases the credential grant when prepare is interrupted mid-clone", () => {
    const ssh = fakeSsh(PROTOCOL);
    ssh.state.hangClone = true;
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER);
      const fiber = yield* Effect.forkChild(executor.prepare(request));
      let spins = 0;
      while (
        !ssh.state.commands.some((command) => (remoteArgs(command)[0] ?? "").includes("'clone'")) &&
        spins < 1_000
      ) {
        yield* Effect.yieldNow;
        spins += 1;
      }
      yield* Fiber.interrupt(fiber);
      const commandLine = ssh.state.commands.map(({ args }) => args.join(" ")).join("\n");
      assert(commandLine.includes("integrations attach"));
      // The compensation ran: the half-attached grant is gone.
      assert(commandLine.includes("integrations detach"));
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect(
    "runs unchanged Attempt envelopes over SSH and cleans the edge grant and worktree",
    () => {
      const ssh = fakeSsh(PROTOCOL);
      const transcript: Array<[AttemptChannel.Direction, AttemptChannel.Envelope]> = [];
      return Effect.gen(function* () {
        const executor = yield* Executor;
        assert.strictEqual(executor.kind, "exe.dev");
        yield* executor.preflight(WORKER);
        const prepared = yield* executor.prepare(request);
        const result = yield* executor.launch(prepared, {
          append: (direction, envelope) =>
            Effect.sync(() => {
              transcript.push([direction, envelope]);
            }),
        });
        assert.strictEqual(result.message, "done");
        assert.deepStrictEqual(
          transcript.map(([direction, envelope]) => [direction, envelope.payload._tag]),
          [
            ["outbound", "Started"],
            ["outbound", "SessionEvent"],
            ["outbound", "Final"],
          ],
        );
        assert.deepStrictEqual(
          ssh.state.inputs.map((input) => input._tag),
          ["Start"],
        );
        const start = ssh.state.inputs[0];
        assert(start?._tag === "Start");
        assert.deepStrictEqual(start.spec, prepared.spec);

        yield* executor.cleanup(prepared);
        yield* executor.cleanup(prepared);

        const commandLines = ssh.state.commands.map(({ args }) => args.join(" "));
        assert(commandLines.some((line) => line.includes("integrations test usine-acme-demo")));
        assert(
          commandLines.some((line) =>
            line.includes("integrations attach usine-acme-demo vm:remote-one --for 65m"),
          ),
        );
        assert(
          commandLines.some((line) => line.includes("https://github.int.exe.xyz/acme/demo.git")),
        );
        assert(commandLines.some((line) => line.includes("export GH_HOST=github.int.exe.xyz")));
        assert(
          commandLines.some((line) => line.includes("'main;$(touch$IFS/tmp/usine-injected)'")),
        );
        assert(commandLines.some((line) => line.includes("integrations detach usine-acme-demo")));
        assert(
          commandLines.some((line) => line.includes("attempts/abandoned-attempt")),
          "the first prepare must sweep a crash-leftover worktree",
        );
        assert(
          commandLines.some(
            (line) => line.includes("repos/acme_demo.git") && line.includes("worktree' 'prune"),
          ),
          "the first prepare must prune crash-leftover cache registrations",
        );
        for (const command of ssh.state.commands) {
          assert.strictEqual(command.options.extendEnv, false);
          for (const name of Object.keys(command.options.env ?? {})) {
            assert(SSH_ENVIRONMENT_ALLOWLIST.has(name), `unexpected SSH environment key: ${name}`);
          }
          assert(!("USINE_GITHUB_PRIVATE_KEY" in (command.options.env ?? {})));
          assert(!("GH_TOKEN" in (command.options.env ?? {})));
          assert(!("GITHUB_TOKEN" in (command.options.env ?? {})));
          if (command.args.includes("integrations")) assert(!command.args.includes("--json"));
          const separator = command.args.indexOf("--");
          if (separator >= 0) assert.strictEqual(command.args.slice(separator + 1).length, 1);
        }
      }).pipe(Effect.provide(runtime(ssh.layer)));
    },
  );

  it.effect("refreshes a shared grant for each Attempt and detaches after the last cleanup", () => {
    const ssh = fakeSsh(PROTOCOL);
    const secondRequest = new CheckoutRequest({
      ...request,
      attemptId: Attempt.AttemptId.make("remote-run/execute/2"),
    });
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER);
      const first = yield* executor.prepare(request);
      const second = yield* executor.prepare(secondRequest);
      const matchingCommands = (subcommand: string) =>
        ssh.state.commands.filter(
          ({ args }) => args.includes("integrations") && args.includes(subcommand),
        );
      assert.strictEqual(matchingCommands("attach").length, 2);
      yield* executor.cleanup(first);
      assert.strictEqual(matchingCommands("detach").length, 0);
      yield* executor.cleanup(second);
      assert.strictEqual(matchingCommands("detach").length, 1);
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("surfaces run-host skew as a typed preflight capability error", () => {
    const ssh = fakeSsh("1");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.preflight(WORKER).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
      if (error._tag !== "WorkerCapabilityError") return;
      assert.strictEqual(error.capability, "run-host");
      assert(error.message.includes(`expected ${PROTOCOL}`));
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("requires a successful SSH exit after the final envelope", () => {
    const ssh = fakeSsh(PROTOCOL, "final-nonzero");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER);
      const prepared = yield* executor.prepare(request);
      const error = yield* executor
        .launch(prepared, { append: () => Effect.void })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "InfraFailure");
      assert(error.message.includes("exited with code 17"));
      yield* executor.cleanup(prepared);
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("cancels once through the SSH channel and confirms the remote interrupt", () => {
    const ssh = fakeSsh(PROTOCOL, "wait-for-interrupt");
    const transcript: Array<[AttemptChannel.Direction, AttemptChannel.Envelope]> = [];
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER);
      const prepared: PreparedAttempt = yield* executor.prepare(request);
      const launchFiber = yield* executor
        .launch(prepared, {
          append: (direction, envelope) =>
            Effect.sync(() => {
              transcript.push([direction, envelope]);
            }),
        })
        .pipe(Effect.result, Effect.forkChild);
      while (!transcript.some(([, envelope]) => envelope.payload._tag === "Started")) {
        yield* Effect.yieldNow;
      }

      yield* executor.cancel(ATTEMPT_ID);
      yield* executor.cancel(ATTEMPT_ID);
      const outcome = yield* Fiber.join(launchFiber);
      assert(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "AgentFailure");
      assert.deepStrictEqual(
        ssh.state.inputs.map((input) => input._tag),
        ["Start", "InboundEnvelope"],
      );
      assert.deepStrictEqual(
        transcript.map(([direction, envelope]) => [direction, envelope.payload._tag]),
        [
          ["outbound", "Started"],
          ["inbound", "Interrupt"],
          ["outbound", "Interrupted"],
        ],
      );
      assert.strictEqual(ssh.state.kills, 0);
      yield* executor.cleanup(prepared);
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("kills a stalled SSH session after the interrupt grace", () => {
    const ssh = fakeSsh(PROTOCOL, "ignore-interrupt");
    const transcript: Array<[AttemptChannel.Direction, AttemptChannel.Envelope]> = [];
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER);
      const prepared = yield* executor.prepare(request);
      const launchFiber = yield* executor
        .launch(prepared, {
          append: (direction, envelope) =>
            Effect.sync(() => {
              transcript.push([direction, envelope]);
            }),
        })
        .pipe(Effect.result, Effect.forkChild);
      while (!transcript.some(([, envelope]) => envelope.payload._tag === "Started")) {
        yield* Effect.yieldNow;
      }

      const cancelFiber = yield* executor.cancel(ATTEMPT_ID).pipe(Effect.forkChild);
      while (!transcript.some(([, envelope]) => envelope.payload._tag === "Interrupt")) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(cancelFiber);
      yield* executor.cancel(ATTEMPT_ID);
      const outcome = yield* Fiber.join(launchFiber);
      assert(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "InfraFailure");
      assert.strictEqual(ssh.state.kills, 1);
      yield* executor.cleanup(prepared);
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("hard-kills when the persisted interrupt write is parked", () => {
    const ssh = fakeSsh(PROTOCOL, "ignore-interrupt");
    const transcript: Array<[AttemptChannel.Direction, AttemptChannel.Envelope]> = [];
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER);
      const prepared = yield* executor.prepare(request);
      const launchFiber = yield* executor
        .launch(prepared, {
          append: (direction, envelope) =>
            direction === "inbound"
              ? Effect.never
              : Effect.sync(() => {
                  transcript.push([direction, envelope]);
                }),
        })
        .pipe(Effect.result, Effect.forkChild);
      while (!transcript.some(([, envelope]) => envelope.payload._tag === "Started")) {
        yield* Effect.yieldNow;
      }

      const cancelFiber = yield* executor.cancel(ATTEMPT_ID).pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      const canceled = yield* Fiber.join(cancelFiber);
      assert(Result.isFailure(canceled));
      if (Result.isFailure(canceled)) {
        assert.strictEqual(canceled.failure._tag, "ExecutorOperationError");
      }
      assert.strictEqual(ssh.state.kills, 1);
      yield* executor.cancel(ATTEMPT_ID);
      const outcome = yield* Fiber.join(launchFiber);
      assert(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "InfraFailure");
      yield* executor.cleanup(prepared);
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });
});
