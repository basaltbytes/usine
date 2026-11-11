import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { sdkProcessSpawner } from "../../src/child-host/sdk.ts";
import { ChildSessionLifecycle } from "../../src/runtime.ts";

/** A process spawner whose single spawn starts, or fails with `PlatformError`, once `gate` opens. */
const gatedSpawner = (gate: Deferred.Deferred<boolean>) =>
  ChildProcessSpawner.make(() =>
    Deferred.await(gate).pipe(
      Effect.flatMap((starts) =>
        starts
          ? Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(4242),
                exitCode: Effect.never,
                isRunning: Effect.succeed(true),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: Stream.never,
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              }),
            )
          : Effect.fail(
              PlatformError.badArgument({
                module: "test",
                method: "spawn",
                description: "the process failed to start",
              }),
            ),
      ),
    ),
  );

for (const starts of [true, false])
  it.live(
    `acknowledges output only once the SDK process ${starts ? "starts" : "fails to start"}`,
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<boolean>();
        const owner = yield* sdkProcessSpawner({
          host: LocalProcess.make(),
          cwd: "/worktree",
          environment: {},
          sessionId: Option.none(),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, gatedSpawner(gate)));
        yield* owner.acknowledge(0);
        const beforeSpawn = yield* Effect.forkChild(owner.acknowledge(5));
        yield* Effect.sleep("20 millis");
        assert.strictEqual(beforeSpawn.pollUnsafe(), undefined);
        const process = owner.spawn({
          command: "claude",
          args: [],
          env: {},
          signal: yield* Effect.abortSignal,
        });
        process.on("error", () => {});
        process.stdout.on("error", () => {});
        yield* Effect.sleep("20 millis");
        assert.strictEqual(beforeSpawn.pollUnsafe(), undefined);
        yield* Deferred.succeed(gate, starts);
        yield* Fiber.join(beforeSpawn).pipe(Effect.timeout("1 second"));
        yield* owner.acknowledge(5).pipe(Effect.timeout("1 second"));
      }).pipe(
        Effect.provideService(ChildSessionLifecycle, { isStopping: Effect.succeed(false) }),
        Effect.scoped,
      ),
  );
