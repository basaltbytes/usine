import { assert, describe, it } from "@effect/vitest";
import { Attempt, AttemptChannel, Repository, StepResult, Worker } from "@usine/core";
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
const REVISION = Repository.Revision.make("main");
const COMMIT = Repository.CommitSha.make("0123456789abcdef0123456789abcdef01234567");
const TASK = AttemptChannel.Task.make("Complete the remote task");
const INTEGRATION = IntegrationName.make("usine-acme-demo");
const encoder = new TextEncoder();
const decodeInput = Schema.decodeUnknownEffect(AttemptChannel.InputFrameFromJson);
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(AttemptChannel.OutboundEnvelope));

type LaunchMode = "success" | "final-nonzero" | "wait-for-interrupt" | "ignore-interrupt";

interface FakeSshState {
  readonly commands: Array<StandardCommand>;
  readonly inputs: Array<AttemptChannel.InputFrame>;
  kills: number;
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
                payload: new AttemptChannel.Started(),
              }),
            );
            if (mode === "success" || mode === "final-nonzero") {
              yield* emit(
                new AttemptChannel.OutboundEnvelope({
                  version: AttemptChannel.PROTOCOL_VERSION,
                  attemptId: input.spec.attemptId,
                  sequence: AttemptChannel.Sequence.make(2),
                  sentAt: DateTime.makeUnsafe("2026-08-31T12:00:01Z"),
                  payload: new AttemptChannel.AgentMessage({ message: "Remote work completed" }),
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

const fakeSsh = (protocol: string, mode: LaunchMode = "success") => {
  const state: FakeSshState = { commands: [], inputs: [], kills: 0 };
  const service = ChildProcessSpawner.make(
    Effect.fn("FakeSsh.spawn")(function* (command) {
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
      state.commands.push(command);
      const remote = remoteArgs(command);
      if (remote[0] === "sh" && remote[1] === "-c") {
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
      if (remote[0] === "printenv") return oneShotHandle("/home/exedev\n", 0);
      if (remote[0] === "git" && remote[1] === "--version") {
        return oneShotHandle("git version 2.50.1\n", 0);
      }
      if (remote[0] === "node" && remote[1] === "--version") {
        return oneShotHandle("v22.18.0\n", 0);
      }
      if (remote[0] === "usine-run-host" && remote.includes("--protocol-version")) {
        return oneShotHandle(`${protocol}\n`, 0);
      }
      if (remote[0] === "test") return oneShotHandle("", 1);
      if (remote[0] === "git" && remote.includes("rev-parse")) {
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
  task: TASK,
});

const runtime = (sshLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  exeDevLayer({
    githubIntegrations: [integration],
    harnessLoginChecks: [harness],
  }).pipe(Layer.provide(sshLayer));

describe("exe.dev executor", () => {
  it.effect(
    "runs unchanged Attempt envelopes over SSH and cleans the edge grant and worktree",
    () => {
      const ssh = fakeSsh("1");
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
            ["outbound", "AgentMessage"],
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
        assert(commandLines.some((line) => line.includes("sh -c")));
        assert(commandLines.some((line) => line.includes("integrations detach usine-acme-demo")));
        for (const command of ssh.state.commands) {
          assert(!("GH_TOKEN" in (command.options.env ?? {})));
          assert(!("GITHUB_TOKEN" in (command.options.env ?? {})));
        }
      }).pipe(Effect.provide(runtime(ssh.layer)));
    },
  );

  it.effect("surfaces run-host skew as a typed preflight capability error", () => {
    const ssh = fakeSsh("2");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.preflight(WORKER).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
      if (error._tag !== "WorkerCapabilityError") return;
      assert.strictEqual(error.capability, "run-host");
      assert(error.message.includes("expected 1"));
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("requires a successful SSH exit after the final envelope", () => {
    const ssh = fakeSsh("1", "final-nonzero");
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
    const ssh = fakeSsh("1", "wait-for-interrupt");
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
    const ssh = fakeSsh("1", "ignore-interrupt");
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
});
