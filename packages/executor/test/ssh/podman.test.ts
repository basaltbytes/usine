import { assert, describe, it } from "@effect/vitest";
import { CHILD_KILL_SCRIPT, RemoteShell } from "@usine/agents/child-host";
import type { ContainerOutOfMemoryKills } from "@usine/core/attempt";
import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import { completes, type StubParent } from "@usine/durable/testing";
import { Deferred, Effect, Fiber, Option, Layer, Schema } from "effect";
import { Executor } from "../../src/executor.ts";
import { ATTEMPT_IMAGE } from "../../src/ssh/ssh.ts";
import { fakeGateway, gatewayRuntime } from "./gateway/support.ts";
import {
  aloneOnItem,
  capturedLogs,
  fails,
  fakeContainerId,
  fakeMachine,
  INSTANCE,
  INSTANCE_ID,
  mintingProvider,
  request,
  runtime,
  TEST_AGENT,
  WORKER,
} from "./support.ts";

const CONTAINER = "usine-remote-run_execute_1";
const info = () => ({
  version: { Version: "5.4.2" },
  host: {
    security: { rootless: true },
    serviceIsRemote: false,
    cgroupVersion: "v2",
    cgroupManager: "systemd",
    cgroupControllers: ["cpu", "memory", "pids"],
    kernel: "6.12.43+deb13-amd64",
    ociRuntime: { name: "crun", version: "crun version 1.21" },
  },
});
const podmanMachine = () => {
  const machine = fakeMachine();
  machine.state.podmanInfo = JSON.stringify(info());
  return machine;
};
const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

describe("rootless Podman", () => {
  it.effect.each(["preflight", "prepare"] as const)(
    "pulls a missing image before the first container during %s",
    (operation) => {
      const machine = podmanMachine();
      machine.state.imageOnMachine = false;
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        if (operation === "preflight") yield* executor.preflight(WORKER, [], 1);
        else yield* executor.prepare(request);
        const warnings = logs.warnings.filter((line) => line.includes("image is absent"));
        assert.lengthOf(warnings, 1);
        assert.include(warnings[0] ?? "", ATTEMPT_IMAGE);
        const inspections = logs.lines.filter((line) =>
          line.includes("Inspected the attempt image"),
        );
        assert.include(inspections[0] ?? "", '"status":"absent"');
        const pulls = logs.lines.filter((line) => line.includes("Pulled the attempt image"));
        assert.lengthOf(pulls, 1);
        assert.deepInclude(JSON.parse(pulls[0] ?? "")[1], {
          image: ATTEMPT_IMAGE,
          runtime: "podman",
          downloaded: true,
          durationMillis: 0,
        });
        const commands = machine.state.calls.map(({ line }) => line);
        const pull = commands.indexOf(`exec 'podman' 'pull' '--quiet' '${ATTEMPT_IMAGE}'`);
        assert.isAtLeast(pull, 0);
        assert.lengthOf(
          commands.filter((line) => line.startsWith("exec 'podman' 'pull'")),
          1,
        );
        const firstContainer = commands.findIndex(
          (line) => line.includes("--entrypoint") || line.includes("volume create"),
        );
        assert.isAbove(firstContainer, pull);
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
      );
    },
  );

  it.effect.each([1, 125, 255])(
    "preserves image inspection failure with exit code %s",
    (exitCode) => {
      const machine = podmanMachine();
      machine.state.imageInspectFailure = {
        exitCode,
        stderr: "Error: opening image storage: permission denied",
      };
      return Effect.gen(function* () {
        const error = yield* (yield* Executor).preflight(WORKER, [], 1).pipe(Effect.flip);
        assert.strictEqual(error._tag, "WorkerCapabilityError");
        assert.include(error.message, "Can't inspect the attempt image");
        assert(!machine.state.calls.some(({ line }) => line.startsWith("exec 'podman' 'pull'")));
      }).pipe(Effect.provide(runtime(machine, mintingProvider())));
    },
  );

  it.effect("runs preflight through exec and reports runtime evidence", () => {
    const machine = podmanMachine();
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const report = yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      assert.isTrue(Option.isNone(report.degraded));
      assert.include(logs.lines.join("\n"), '"ociRuntime":"crun"');
      assert.include(logs.lines.join("\n"), '"kernel":"6.12.43+deb13-amd64"');
      const probe = machine.state.calls.find(({ line }) => line.includes("/sys/fs/cgroup/cpu.max"));
      assert.match(probe?.container ?? "", /^usine-preflight-/u);
      assert.strictEqual(machine.state.containers.size, 0);
    }).pipe(
      Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
    );
  });

  it.effect.each([
    [
      "rootful",
      (value: ReturnType<typeof info>) => {
        value.host.security.rootless = false;
      },
    ],
    [
      "remote service",
      (value: ReturnType<typeof info>) => {
        value.host.serviceIsRemote = true;
      },
    ],
    [
      "cgroup v1",
      (value: ReturnType<typeof info>) => {
        value.host.cgroupVersion = "v1";
      },
    ],
    [
      "cgroupfs",
      (value: ReturnType<typeof info>) => {
        value.host.cgroupManager = "cgroupfs";
      },
    ],
    [
      "missing CPU delegation",
      (value: ReturnType<typeof info>) => {
        value.host.cgroupControllers = ["memory", "pids"];
      },
    ],
  ] as const)("refuses %s instead of running as the shared SSH user", ([, change]) => {
    const machine = podmanMachine();
    const value = info();
    change(value);
    machine.state.podmanInfo = JSON.stringify(value);
    return Effect.gen(function* () {
      const error = yield* (yield* Executor).preflight(WORKER, [], 1).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
      assert.include(error.message, "Delegate=");
      assert.strictEqual(machine.state.containers.size, 0);
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect.each(["not JSON", "{}"])("rejects malformed structured info: %s", (output) => {
    const machine = podmanMachine();
    machine.state.podmanInfo = output;
    return Effect.gen(function* () {
      const error = yield* (yield* Executor).preflight(WORKER, [], 1).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect.each([
    "Allocate non-overlapping ranges in /etc/subuid",
    "Enable lingering with loginctl enable-linger usine",
    "Remove the SSH user from the docker group",
  ])("preserves remediation for a missing prerequisite: %s", (message) => {
    const machine = podmanMachine();
    machine.state.rootlessSessionError = message;
    return Effect.gen(function* () {
      const error = yield* (yield* Executor).preflight(WORKER, [], 1).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
      assert.include(error.message, message);
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect("refuses unenforced limits even with no harnesses and removes the probe", () => {
    const machine = podmanMachine();
    machine.state.limitsEnforced = false;
    return Effect.gen(function* () {
      const error = yield* (yield* Executor).preflight(WORKER, [], 1).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
      assert.include(error.message, "did not enforce");
      assert.strictEqual(machine.state.containers.size, 0);
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect("rejects matching UIDs with mismatched GIDs", () => {
    const machine = podmanMachine();
    machine.state.imageGroupId = "2345";
    return Effect.gen(function* () {
      const error = yield* (yield* Executor).preflight(WORKER, [], 1).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
      assert.include(error.message, "group ID 2345");
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect(
    "keeps caller tokens on stdin and preserves host networking and keep-id through child execution",
    () => {
      const machine = podmanMachine();
      const gateway = fakeGateway(machine);
      const parent: StubParent = (context) => {
        assert(Schema.is(RemoteShell)(context.request.host));
        assert.deepStrictEqual(context.request.host.container, {
          runtime: "podman",
          name: CONTAINER,
        });
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* (yield* executor.prepare(request)).launch(sink);
        const started = machine.state.calls.find(
          ({ line }) => line.startsWith("exec 'podman' 'run'") && line.includes(`'${CONTAINER}'`),
        );
        assert(started !== undefined);
        assert.include(started.line, "'--userns=keep-id'");
        assert.include(started.line, "'--cgroupns=private'");
        assert.include(started.line, "'--http-proxy=false'");
        assert.include(
          started.line,
          "'--volume' 'usine-pnpm-store:/home/usine/.local/share/pnpm/store:nocopy'",
        );
        assert.notInclude(started.line, "volume-nocopy");
        assert.include(started.line, "'--network' 'host'");
        const token = /^GH_TOKEN=(.+)$/mu.exec(started.input)?.[1];
        assert(token !== undefined);
        assert(!machine.state.calls.some(({ line }) => line.includes(token)));
        assert.include(started.input, "HTTPS_PROXY=http://gw.test:3128\n");
        assert.strictEqual(machine.state.containers.size, 0);
        assert(
          machine.state.calls.some(
            ({ line }) => line === `exec 'podman' 'rm' '--force' '--volumes' '${CONTAINER}'`,
          ),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayRuntime(machine, mintingProvider(), gateway, { parent })),
      );
    },
  );

  it.effect.each(["child", "init"] as const)(
    "records %s OOM kills and salvages before removing the container",
    (victim) => {
      const machine = podmanMachine();
      machine.state.salvage = "dirty";
      const parent: StubParent = (context) =>
        Effect.sync(() => {
          const container = machine.state.containers.get(CONTAINER);
          assert(container !== undefined);
          if (victim === "init") container.running = false;
          else container.oomKills = 2;
        }).pipe(Effect.andThen(fails(context)));
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const kills: Array<ContainerOutOfMemoryKills> = [];
        const salvages: Array<AttemptSalvage> = [];
        yield* (yield* executor.prepare(request))
          .launch({
            ...sink,
            outOfMemory: (value) => Effect.sync(() => void kills.push(value)),
            salvage: (value) => Effect.sync(() => void salvages.push(value)),
          })
          .pipe(Effect.flip);
        assert.strictEqual(kills[0]?.kills, victim === "init" ? 1 : 2);
        assert.strictEqual(salvages[0]?._tag, "Pushed");
        if (victim === "init")
          assert(
            machine.state.calls.some(({ line }) => line === `exec 'podman' 'start' '${CONTAINER}'`),
          );
        assert.strictEqual(machine.state.containers.size, 0);
        assert(
          machine.state.calls.some(
            ({ line, container }) => container === CONTAINER && line.includes("'push' '--force'"),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), parent)));
    },
  );

  it.effect.each(["unreadable", "empty"] as const)(
    "warns instead of recording zero when the OOM counter is %s",
    (counter) => {
      const machine = podmanMachine();
      machine.state.memoryEvents = counter;
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const kills: Array<ContainerOutOfMemoryKills> = [];
        yield* (yield* executor.prepare(request)).launch({
          ...sink,
          outOfMemory: (value) => Effect.sync(() => void kills.push(value)),
        });
        assert.deepStrictEqual(kills, []);
        assert.include(logs.lines.join("\n"), "Could not record the processes the kernel killed");
        assert.strictEqual(machine.state.containers.size, 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(machine, mintingProvider()).pipe(Layer.provideMerge(logs.layer))),
      );
    },
  );

  it.effect("does not confuse Podman's exit code 3 with an absent runtime", () => {
    const machine = podmanMachine();
    machine.state.runtimeExitCode = 3;
    return Effect.gen(function* () {
      const error = yield* (yield* Executor).preflight(WORKER, [], 1).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });

  it.effect("cancels the parent, stops children through Podman, and removes the container", () => {
    const machine = podmanMachine();
    const started = Deferred.makeUnsafe<void>();
    const parent: StubParent = () =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      const launch = yield* prepared.launch(sink).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* executor.cancel(request.attemptId, "cancel");
      yield* Fiber.await(launch);
      const stopped = machine.state.calls.find(({ line }) => line.includes(CHILD_KILL_SCRIPT));
      assert.include(stopped?.line ?? "", "'podman'");
      assert.strictEqual(machine.state.containers.size, 0);
    }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider(), parent)));
  });

  it.effect("sweeps only both matching instance labels and preserves shared volumes", () => {
    const machine = podmanMachine();
    for (const [name, instanceId] of [
      ["usine-left", INSTANCE_ID],
      ["usine-other", "another-instance"],
    ] as const) {
      machine.state.containers.set(name, {
        id: fakeContainerId(++machine.state.containersCreated),
        args: [],
        labels: new Map([
          ["dev.usine.instance", INSTANCE],
          ["dev.usine.instance-id", instanceId],
          ["dev.usine.worker", WORKER],
        ]),
        environment: "",
        running: true,
        oomKills: 0,
      });
    }
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* Effect.scoped(executor.prepare(request));
      assert.deepStrictEqual([...machine.state.containers.keys()], ["usine-other"]);
      assert(!machine.state.calls.some(({ line }) => line.includes("'volume' 'rm'")));
    }).pipe(Effect.provide(runtime(machine, mintingProvider())));
  });
});
