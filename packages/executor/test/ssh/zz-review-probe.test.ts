import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Executor } from "../../src/executor.ts";
import { imageRepository } from "../../src/ssh/image.ts";
import { ATTEMPT_IMAGE } from "../../src/ssh/ssh.ts";
import { fakeMachine, mintingProvider, runtime, WORKER } from "./support.ts";

const REPOSITORY = imageRepository(ATTEMPT_IMAGE);

describe("review probe: preflight on a worker below its threshold", () => {
  it.effect("still removes older worker images before it reports the disk error", () => {
    const machine = fakeMachine();
    machine.state.docker = "running";
    machine.state.storageFreeDiskGib = 3.5;
    machine.state.pulledImageId = "sha256:c0";
    machine.state.workerImages = [
      `sha256:c0 ${REPOSITORY} current 2026-11-13 08:00:00 +0000 UTC`,
      `sha256:b0 ${REPOSITORY} previous 2026-11-12 08:00:00 +0000 UTC`,
      `sha256:a1 ${REPOSITORY} older 2026-11-11 08:00:00 +0000 UTC`,
    ];
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.preflight(WORKER, [], 1).pipe(Effect.flip);
      console.log("PROBE error:", error._tag, (error as { capability?: string }).capability, error.message);
      console.log("PROBE removals:", JSON.stringify(machine.state.imageRemovals));
      assert.deepStrictEqual(machine.state.imageRemovals, [[`${REPOSITORY}:older`]]);
    }).pipe(Effect.scoped, Effect.provide(runtime(machine, mintingProvider())));
  });
});
