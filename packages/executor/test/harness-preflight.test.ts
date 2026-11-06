import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, describe, it } from "@effect/vitest";
import { RemoteShell } from "@usine/agents/child-host";
import { catalog } from "@usine/agents/harness";
import { HarnessReady } from "@usine/core/agent/capability";
import {
  Harnesses,
  harnessesLive,
  type HarnessRuntime,
  type ProbeTarget,
} from "@usine/agents/harness/node";
import type { ChildHost } from "@usine/agents/child-host";
import { HostLoginLock } from "@usine/agents/runtime";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { MachineId, WorkerName } from "@usine/core/worker";
import { Deferred, Effect, Fiber, Layer, Option, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";

import { hostLoginLockLayer } from "../src/executor.ts";
import {
  agentsHarnessProbe,
  type HarnessProbe,
  verifyHarnessReadiness,
} from "../src/harness-preflight.ts";

const claude = BrainSpec.make({
  harness: Harness.make("claude"),
  model: ModelId.make("sonnet"),
  effort: "low",
});
const host = RemoteShell.make({
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

const noLock = HostLoginLock.of({ withLock: () => (effect) => effect });
const probeHarness =
  (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    target: ChildHost,
    environment: Readonly<Record<string, string>>,
    logins: HostLoginLock["Service"],
  ): HarnessProbe =>
  (brain, login) =>
    Effect.gen(function* () {
      const harnesses = yield* Harnesses;
      return yield* agentsHarnessProbe(harnesses, target, environment)(brain, login);
    }).pipe(
      Effect.provide(
        harnessesLive.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Layer.provide(Layer.succeed(HostLoginLock, logins)),
          Layer.orDie,
        ),
      ),
    );

const login = {
  worker: WorkerName.make("test-worker"),
  machine: Option.none(),
};

describe("injected harness registry", () => {
  it.effect("reuses the app registry for repeated executor probes", () => {
    let registrations = 0;
    const targets: Array<ProbeTarget> = [];
    const registry = Layer.suspend(() => {
      registrations += 1;
      return Harnesses.layerFrom(
        catalog,
        catalog.ids.map((id): HarnessRuntime => ({
          id,
          stop: () => Effect.die("preflight must not stop a child"),
          launch: () => Effect.die("preflight must not launch a child"),
          preflight: (brain, target) =>
            Effect.sync(() => {
              targets.push(target);
              return HarnessReady.make({ harness: brain.harness });
            }),
        })),
      );
    });
    return Effect.gen(function* () {
      const harnesses = yield* Harnesses;
      const probe = agentsHarnessProbe(harnesses, host, { PATH: "/worker/bin" }, "gateway");
      yield* verifyHarnessReadiness(login.worker, login.machine, [claude], probe);
      yield* verifyHarnessReadiness(login.worker, login.machine, [claude], probe);
      assert.strictEqual(registrations, 1);
      assert.strictEqual(targets.length, 2);
      for (const target of targets) {
        assert.strictEqual(target.worker, login.worker);
        assert.strictEqual(target.host, host);
        assert.strictEqual(target.credential, "gateway");
        assert.deepStrictEqual(target.environment, { PATH: "/worker/bin" });
      }
    }).pipe(Effect.provide(registry));
  });
});

describe("harness probe on a remote host", () => {
  it.effect("runs each check as one SSH command with exactly the SSH client's environment", () =>
    Effect.gen(function* () {
      const spawned: Array<ChildProcess.StandardCommand> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (command._tag === "StandardCommand") spawned.push(command);
          return exited(255);
        }),
      );
      yield* probeHarness(spawner, host, {}, noLock)(claude, login).pipe(Effect.flip);
      const first = spawned[0];
      assert(first !== undefined);
      assert.strictEqual(first.command, "ssh");
      assert.deepStrictEqual(first.args, [
        "-o",
        "BatchMode=yes",
        "remote-one.exe.xyz",
        "--",
        "exec 'node' '--version'",
      ]);
      assert.deepStrictEqual(first.options.env, host.sshEnvironment);
      assert.strictEqual(first.options.extendEnv, false);
    }),
  );

  it.effect("keeps an unreachable Worker's failure retryable instead of a capability gap", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(exited(255)));
      const error = yield* probeHarness(spawner, host, {}, noLock)(claude, login).pipe(Effect.flip);
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
      const pending = yield* probeHarness(
        spawner,
        host,
        {},
        noLock,
      )(claude, login).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual((yield* Fiber.join(pending))._tag, "ExecutorOperationError");
      assert(closed, "the timed-out probe must release its process scope");
    }),
  );
});

describe("harness readiness on a Worker", () => {
  it.effect("waits for a busy login before starting the preflight deadline", () =>
    Effect.gen(function* () {
      const logins = yield* HostLoginLock;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const worker = WorkerName.make("busy-worker");
      const held = yield* logins
        .withLock(
          claude.harness,
          worker,
          Option.none(),
        )(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const auth = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}';
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            ...exited(0),
            stdout: Stream.make(new TextEncoder().encode(auth)),
          }),
        ),
      );
      const waiting = yield* verifyHarnessReadiness(
        worker,
        Option.none(),
        [claude],
        probeHarness(spawner, host, {}, logins),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("61 seconds");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(held);
      yield* Fiber.join(waiting);
    }).pipe(Effect.provide(hostLoginLockLayer)),
  );

  it.effect(
    "checks Claude on one Worker one probe at a time, and other Workers and the machines of a provisioned Worker alongside",
    () =>
      Effect.gen(function* () {
        const logins = yield* HostLoginLock;
        const probe = Effect.fn(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const auth = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}';
          const spawner = ChildProcessSpawner.make((command) => {
            const isVersion =
              command._tag === "StandardCommand" &&
              command.args.some((arg) => arg.includes("--version"));
            const ready = Effect.succeed(
              ChildProcessSpawner.makeHandle({
                ...exited(0),
                stdout: Stream.make(new TextEncoder().encode(isVersion ? "2.1.311" : auth)),
              }),
            );
            return isVersion
              ? ready
              : Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(ready),
                );
          });
          const check: HarnessProbe = probeHarness(spawner, host, {}, logins);
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
              verifyHarnessReadiness(worker, Option.none(), [claude], first.check),
              verifyHarnessReadiness(worker, Option.none(), [claude], second.check),
              verifyHarnessReadiness(
                WorkerName.make("worker-2"),
                Option.none(),
                [claude],
                elsewhere.check,
              ),
              verifyHarnessReadiness(
                provisioned,
                machine("52341896"),
                [claude],
                onOneMachine.check,
              ),
              verifyHarnessReadiness(
                provisioned,
                machine("52341897"),
                [claude],
                onOtherMachine.check,
              ),
            ],
            { concurrency: "unbounded" },
          ),
        );
        yield* Deferred.await(first.entered);
        yield* Deferred.await(elsewhere.entered);
        yield* Deferred.await(onOneMachine.entered);
        yield* Deferred.await(onOtherMachine.entered);
        const enteredDone = yield* Deferred.isDone(second.entered);
        assert.isFalse(
          enteredDone,
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
      }).pipe(Effect.provide(hostLoginLockLayer)),
  );
});
