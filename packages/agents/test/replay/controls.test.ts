import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Stream } from "effect";
import { ChildBackend, HostLoginLock } from "../../src/runtime.ts";
import { childPidFile } from "../../src/child-host/child-host.ts";
import { claudeChildLayer } from "../../src/harness/claude/claude.ts";
import { claudeTransport } from "./claude.ts";
import { openFixture, recordingPid } from "./fixture.ts";
import { runScenario } from "./scenarios.ts";
import { isJsonObject, Tape, type Transcript } from "./transcript.ts";

it.live("Claude waits for the final result when a replayed result has queued turns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* openFixture("claude", "queued-message", "replay");
      const source = fixture.tape.source;
      assert(source !== "record");
      const tape = new Tape({
        ...source,
        entries: source.entries.flatMap((entry): Transcript["entries"] => {
          if (entry.type !== "emit_inbound" || entry.port !== "claude:1/output") return [entry];
          const payload = entry.payload;
          if (!isJsonObject(payload) || payload.type !== "result") return [entry];
          return [
            { ...entry, payload: { ...payload, result: "REPLAY_PENDING", queued_turn_count: 1 } },
            entry,
          ];
        }),
      });
      tape.bind(fixture.cwd, "$WORKTREE");
      const path = fixture.request.environment.PATH;
      assert(path !== undefined);
      tape.bind(path, "$PATH");
      const backend = claudeChildLayer.pipe(
        Layer.provide(claudeTransport(tape)),
        Layer.provide(Layer.succeed(HostLoginLock)({ withLock: () => (effect) => effect })),
        Layer.provide(NodeServices.layer),
      );
      const events = yield* runScenario("queued-message", fixture.request, fixture.controls).pipe(
        Effect.provide(backend),
        tape.guard,
      );
      const idle = events.filter((event) => event._tag === "SessionIdle");
      assert.lengthOf(idle, 1);
      assert.deepStrictEqual(idle[0]?.message, Option.some("REPLAY_GUIDED"));
      tape.assertComplete();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform !== "linux")(
  "Claude interruption stops the replayed owned process",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* openFixture("claude", "transport-loss", "replay");
        const fs = yield* FileSystem.FileSystem;
        const pid = yield* Effect.scoped(
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
            yield* running.interrupt;
            yield* running.result.pipe(Effect.result);
            yield* Fiber.join(events).pipe(Effect.result);
            return pid;
          }).pipe(Effect.provide(fixture.backend)),
        );
        const retained = yield* fs.exists(childPidFile(fixture.cwd, fixture.request.session.id));
        assert.isFalse(retained);
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("5 seconds")),
  10_000,
);
