import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Option, Schedule, Schema, Stream } from "effect";
import { ChildBackend } from "../../src/runtime.ts";
import { childPidFile } from "../../src/child-host/child-host.ts";
import { openFixture, recordingPid } from "./fixture.ts";
import { runScenario } from "./scenarios.ts";
import { isJsonObject, type Transcript } from "./transcript.ts";

class ProcessStillRunning extends Schema.TaggedError<
  ProcessStillRunning,
  { readonly brand: unique symbol }
>()("ProcessStillRunning", { pid: Schema.Int, cause: Schema.Defect() }) {}

it.live(
  "Claude waits for the final result when a replayed result has queued turns",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* openFixture("claude", "queued-message", "replay", {
          transform: (transcript) => ({
            ...transcript,
            entries: transcript.entries.flatMap((entry): Transcript["entries"] => {
              if (entry.type !== "emit_inbound" || entry.port !== "claude:1/output") return [entry];
              const payload = entry.payload;
              if (!isJsonObject(payload) || payload.type !== "result") return [entry];
              return [
                {
                  ...entry,
                  payload: { ...payload, result: "REPLAY_PENDING", queued_turn_count: 1 },
                },
                entry,
              ];
            }),
          }),
        });
        const events = yield* runScenario("queued-message", fixture.request, fixture.controls).pipe(
          Effect.provide(fixture.backend),
          fixture.tape.guard,
        );
        const idle = events.filter((event) => event._tag === "SessionIdle");
        assert.lengthOf(idle, 1);
        assert.deepStrictEqual(idle[0]?.message, Option.some("REPLAY_GUIDED"));
        fixture.tape.assertComplete();
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
  20_000,
);

it.live.skipIf(process.platform !== "linux")(
  "Claude interruption stops the replayed owned process before the launch scope closes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* openFixture("claude", "transport-loss", "replay");
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const running = yield* (yield* ChildBackend).launch(fixture.request);
            const started = yield* Deferred.make<void>();
            const events = yield* running.events.pipe(
              Stream.runForEach((event) =>
                event._tag === "ToolStarted" ? Deferred.succeed(started, undefined) : Effect.void,
              ),
              Effect.forkScoped,
            );
            yield* Deferred.await(started);
            const pidFile = childPidFile(fixture.cwd, fixture.request.session.id);
            const savedPid = yield* fs.readFileString(pidFile);
            const pid = recordingPid(savedPid);
            process.kill(pid, 0);
            // Holding the interrupted result keeps the channel open, so only the interrupt can end input.
            const blockResult = `${fixture.cwd}/block-result`;
            yield* fs.writeFileString(blockResult, "ready");
            yield* running.interrupt;
            yield* Effect.try({
              try: () => assert.throws(() => process.kill(pid, 0), /ESRCH/),
              catch: (cause) => ProcessStillRunning.make({ pid, cause }),
            }).pipe(Effect.retry({ times: 80, schedule: Schedule.spaced("25 millis") }));
            const buffered = yield* fs.exists(`${fixture.cwd}/result-buffered`);
            assert.isTrue(buffered, "the interrupted result is still held back");
            yield* fs.remove(blockResult);
            yield* running.result.pipe(Effect.result);
            yield* Fiber.join(events).pipe(Effect.result);
          }).pipe(Effect.provide(fixture.backend)),
        );
        const retained = yield* fs.exists(childPidFile(fixture.cwd, fixture.request.session.id));
        assert.isFalse(retained);
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("5 seconds")),
  10_000,
);
