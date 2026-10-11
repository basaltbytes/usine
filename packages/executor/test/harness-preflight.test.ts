import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Deferred, Effect, Fiber, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { StandardCommand } from "effect/unstable/process/ChildProcess";
import { agentsHarnessProbe } from "../src/harness-preflight.ts";

const claude = new BrainSpec({ harness: "claude", model: ModelId.make("sonnet"), effort: "low" });
const host = new RemoteShell({
  ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
  sshEnvironment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
  destination: "remote-one.exe.xyz",
});
const sshEnvironment = { PATH: "/usr/bin:/bin", SSH_AUTH_SOCK: "/tmp/agent.sock" };

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
      yield* agentsHarnessProbe(spawner, sshEnvironment, host)(claude).pipe(Effect.flip);
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
      assert.deepStrictEqual(first.options.env, sshEnvironment);
      assert.strictEqual(first.options.extendEnv, false);
    }),
  );

  it.effect("keeps an unreachable Worker's failure retryable instead of a capability gap", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(exited(255)));
      const error = yield* agentsHarnessProbe(
        spawner,
        sshEnvironment,
        host,
      )(claude).pipe(Effect.flip);
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
        sshEnvironment,
        host,
      )(claude).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual((yield* Fiber.join(pending))._tag, "ExecutorOperationError");
      assert(closed, "the timed-out probe must release its process scope");
    }),
  );
});
