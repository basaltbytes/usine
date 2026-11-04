import { assert, it } from "@effect/vitest";
import { ContainerMemoryMib, ContainerScratchMib } from "@usine/core/worker";
import { Effect, Layer, Option, Schema } from "effect";
import { Executor } from "../../src/executor.ts";
import {
  ADDRESS,
  executorLayer,
  fakeMachine,
  mintingProvider,
  noGateway,
  request,
} from "./support.ts";

// Pure serializers and synchronous callbacks return JSON values directly.
// @effect-diagnostics-next-line schemaSync:off
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const cases = [
  { setting: "default", memory: 4096, shm: undefined, tmpfs: undefined, expected: [2048, 2048] },
  { setting: "configured", memory: 4096, shm: 512, tmpfs: 768, expected: [512, 768] },
  { setting: "capped", memory: 256, shm: 4096, tmpfs: 8192, expected: [256, 256] },
  {
    setting: "default capped",
    memory: 256,
    shm: undefined,
    tmpfs: undefined,
    expected: [256, 256],
  },
];

it.effect.each(
  ["docker", "podman"].flatMap((runtime) => cases.map((entry) => ({ runtime, ...entry }))),
)("creates $runtime containers with $setting memory-backed scratch storage", (entry) => {
  const machine = fakeMachine();
  if (entry.runtime === "docker") machine.state.docker = "running";
  else
    machine.state.podmanInfo = stringifyJson({
      version: { Version: "5.4.2" },
      host: {
        security: { rootless: true },
        serviceIsRemote: false,
        cgroupVersion: "v2",
        cgroupManager: "systemd",
        cgroupControllers: ["cpu", "memory", "pids"],
        kernel: "6.12.43",
        ociRuntime: { name: "crun", version: "1.21" },
      },
    });
  const address = {
    ...ADDRESS,
    container: {
      ...ADDRESS.container,
      memoryMib: Option.some(ContainerMemoryMib.make(entry.memory)),
      shmSizeMib: Option.map(Option.fromUndefinedOr(entry.shm), ContainerScratchMib.make),
      tmpfsSizeMib: Option.map(Option.fromUndefinedOr(entry.tmpfs), ContainerScratchMib.make),
    },
  };
  return Effect.gen(function* () {
    yield* (yield* Executor).prepare(request);
    const container = [...machine.state.containers.values()][0];
    assert(container !== undefined);
    const { args, environment } = container;
    assert.strictEqual(args[args.indexOf("--shm-size") + 1], `${entry.expected[0]}m`);
    assert.strictEqual(
      args[args.indexOf("--tmpfs") + 1],
      `/tmp:rw,exec,nosuid,nodev,size=${entry.expected[1]}m,mode=1777`,
    );
    assert.include(environment, "TMPDIR=/tmp\n");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      executorLayer(machine, mintingProvider(), address).pipe(Layer.provide(noGateway)),
    ),
  );
});
