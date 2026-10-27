import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { ClaudeLoginLock } from "@usine/agents/runtime";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { HarnessReady } from "@usine/core/agent/capability";
import { MachineId, WorkerName } from "@usine/core/worker";
import { Deferred, Effect, Fiber, Option, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import type { StandardCommand } from "effect/process/ChildProcess";
import { claudeLoginLockLayer } from "../src/executor.ts";
import {
  agentsHarnessProbe,
  type HarnessProbe,
  verifyHarnessReadiness,
} from "../src/harness-preflight.ts";

const claude = new BrainSpec({ harness: "claude", model: ModelId.make("sonnet"), effort: "low" });
const host = new RemoteShell({
  ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
  sshEnvironment: { PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: "/tmp/agent.sock" },
  destination: "remote-one.exe.xyz",
});

const exited = (exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

describe("harness probe on a remote host", () => {
  it.effect("runs each check as one SSH command with exactly the SSH client's environment", () =>
    Effect.gen(function* () {
      const spawned: Array<StandardCommand> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (command._tag === "StandardCommand") spawned.push(command);
          return exited(255);
        }),
      );
      yield* agentsHarnessProbe(spawner, host, {})(claude).pipe(Effect.flip);
      const first = spawned[0];
      assert(first !== undefined);
      assert.strictEqual(first.command, "ssh");
      assert.deepStrictEqual(first.args, [
        "-o",
        "BatchMode=yes",
        "remote-one.exe.xyz",
        "--",
        "exec 'claude' '--version'",
      ]);
      assert.deepStrictEqual(first.options.env, host.sshEnvironment);
      assert.strictEqual(first.options.extendEnv, false);
    }),
  );

  it.effect("keeps an unreachable Worker's failure retryable instead of a capability gap", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(exited(255)));
      const error = yield* agentsHarnessProbe(spawner, host, {})(claude).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ExecutorOperationError");
    }),
  );

  it.effect("cancels a stalled probe and keeps its timeout retryable", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let closed = false;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }),
        ).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.as(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(2),
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
            }),
          ),
        ),
      );
      const pending = yield* agentsHarnessProbe(
        spawner,
        host,
        {},
      )(claude).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual((yield* Fiber.join(pending))._tag, "ExecutorOperationError");
      assert(closed, "the timed-out probe must release its process scope");
    }),
  );
});

describe("harness readiness on a Worker", () => {
  it.effect(
    "checks Claude on one Worker one probe at a time, and other Workers and the machines of a provisioned Worker alongside",
    () =>
      Effect.gen(function* () {
        const logins = yield* ClaudeLoginLock;
        const probe = Effect.fn(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const check: HarnessProbe = () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(new HarnessReady({ harness: "claude" })),
            );
          return { entered, release, check };
        });
        const [first, second, elsewhere, onOneMachine, onOtherMachine] = yield* Effect.all([
          probe(),
          probe(),
          probe(),
          probe(),
          probe(),
        ]);
        const worker = WorkerName.make("worker-1");
        const provisioned = WorkerName.make("provisioned");
        const machine = (id: string) => Option.some(MachineId.make(id));
        const checks = yield* Effect.forkChild(
          Effect.all(
            [
              verifyHarnessReadiness(worker, Option.none(), [claude], first.check, logins),
              verifyHarnessReadiness(worker, Option.none(), [claude], second.check, logins),
              verifyHarnessReadiness(
                WorkerName.make("worker-2"),
                Option.none(),
                [claude],
                elsewhere.check,
                logins,
              ),
              verifyHarnessReadiness(
                provisioned,
                machine("52341896"),
                [claude],
                onOneMachine.check,
                logins,
              ),
              verifyHarnessReadiness(
                provisioned,
                machine("52341897"),
                [claude],
                onOtherMachine.check,
                logins,
              ),
            ],
            { concurrency: "unbounded" },
          ),
        );
        yield* Deferred.await(first.entered);
        yield* Deferred.await(elsewhere.entered);
        yield* Deferred.await(onOneMachine.entered);
        yield* Deferred.await(onOtherMachine.entered);
        assert.isFalse(
          yield* Deferred.isDone(second.entered),
          "a second Claude check on the Worker waits while the first one runs",
        );
        yield* Deferred.succeed(first.release, undefined);
        yield* Deferred.await(second.entered);
        yield* Effect.forEach(
          [second, elsewhere, onOneMachine, onOtherMachine],
          ({ release }) => Deferred.succeed(release, undefined),
          { discard: true },
        );
        yield* Fiber.join(checks);
      }).pipe(Effect.provide(claudeLoginLockLayer)),
  );
});
