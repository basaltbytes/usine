import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import {
  type Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { ChildProcessLost } from "../../src/child-host/process.ts";
import {
  OpenCodeServer,
  type OpenCodeTarget,
  openCodeServerLive,
} from "../../src/harness/opencode/server.ts";

const encoder = new TextEncoder();

const target: OpenCodeTarget = {
  host: LocalProcess.make(),
  cwd: "/work/checkout",
  environment: { PATH: "/usr/bin:/bin" },
  sessionId: Option.some(AgentSessionId.make("parent:server:child:1")),
};

/**
 * Returns `OpenCodeServer` over a fake bridge process. The bridge prints its ready line when it
 * starts or never, and exits with code 0 once its input ends or keeps running. `kill` makes it
 * exit with code 137, and its exit ends its output and diagnostics.
 */
const fakeBridge = (options: {
  readonly readyLine: "printed" | "withheld";
  readonly atEndOfInput: "exit" | "keep-running";
}) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.make<Uint8Array, Cause.Done>();
    const stderr = yield* Queue.make<Uint8Array, Cause.Done>();
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const started = yield* Deferred.make<void>();
    const inputEnded = yield* Deferred.make<void>();
    const kills = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert(command._tag === "StandardCommand");
        assert.strictEqual(command.args.at(-1), "opencode", "the bridge wraps `opencode`");
        const stdin = command.options.stdin;
        assert(
          Predicate.hasProperty(stdin, "stream") && Stream.isStream(stdin.stream),
          "the server streams the bridge's input",
        );
        yield* Deferred.await(exit).pipe(
          Effect.andThen(Queue.end(stdout)),
          Effect.andThen(Queue.end(stderr)),
          Effect.forkScoped,
        );
        yield* stdin.stream.pipe(
          Stream.runDrain,
          Effect.andThen(Deferred.succeed(inputEnded, undefined)),
          Effect.andThen(
            options.atEndOfInput === "exit"
              ? Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0))
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        if (options.readyLine === "printed")
          yield* Queue.offer(stdout, encoder.encode(`{"ready":true}\n`));
        yield* Deferred.succeed(started, undefined);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Deferred.await(exit),
          isRunning: Deferred.isDone(exit).pipe(Effect.map((exited) => !exited)),
          kill: () =>
            Ref.update(kills, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(137))),
              Effect.asVoid,
            ),
          stdin: Sink.drain,
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.fromQueue(stderr),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    );
    const server = yield* Effect.provide(
      Effect.service(OpenCodeServer),
      openCodeServerLive.pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)),
      ),
    );
    return {
      server,
      started: Deferred.await(started),
      inputEnded: Deferred.await(inputEnded),
      kills: Ref.get(kills),
      /** Writes `diagnostics` to stderr and exits with `code`. */
      crash: (code: number, diagnostics: string) =>
        Queue.offer(stderr, encoder.encode(diagnostics)).pipe(
          Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(code))),
          Effect.asVoid,
        ),
    };
  });

describe("OpenCode server", () => {
  it.effect("fails to open a bridge that isn't ready within 60 seconds", () =>
    Effect.gen(function* () {
      const bridge = yield* fakeBridge({ readyLine: "withheld", atEndOfInput: "exit" });
      const opened = yield* bridge.server
        .open(target)
        .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
      yield* bridge.started;
      yield* TestClock.adjust("59 seconds");
      assert.isUndefined(opened.pollUnsafe(), "the server waits 60 seconds for the ready line");
      yield* TestClock.adjust("1 second");
      assert.isDefined(opened.pollUnsafe(), "the server stops waiting after 60 seconds");
      const error = yield* Fiber.join(opened);
      assert.strictEqual(error._tag, "SessionOperationError");
      assert.strictEqual(error.operation, "launch");
      assert.strictEqual(error.message, "OpenCode wasn't ready within 60 seconds");
    }),
  );

  it.effect("fails the events of a bridge that exits before the session closes it", () =>
    Effect.gen(function* () {
      const bridge = yield* fakeBridge({ readyLine: "printed", atEndOfInput: "exit" });
      const connection = yield* bridge.server.open(target);
      yield* bridge.crash(3, "OpenCode ran out of memory\n");
      const error = yield* connection.events.pipe(Stream.runDrain, Effect.flip);
      assert.strictEqual(error._tag, "SessionOperationError");
      assert(Schema.is(ChildProcessLost)(error.cause), "the error carries the lost process");
      assert.strictEqual(error.cause.exitCode, 3);
      assert.strictEqual(error.cause.stderrTail, "OpenCode ran out of memory\n");
      assert.include(error.message, "exited with code 3");
      assert.include(error.message, "OpenCode ran out of memory");
    }).pipe(Effect.scoped),
  );

  it.effect("stops a bridge that doesn't exit within 15 seconds of its input ending", () =>
    Effect.gen(function* () {
      const bridge = yield* fakeBridge({ readyLine: "printed", atEndOfInput: "keep-running" });
      const scope = yield* Scope.make();
      yield* bridge.server.open(target).pipe(Scope.provide(scope));
      const closed = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* bridge.inputEnded;
      yield* TestClock.adjust("14 seconds");
      const waiting = yield* bridge.kills;
      assert.strictEqual(waiting, 0, "the server waits 15 seconds for the exit");
      assert.isUndefined(closed.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const stopped = yield* bridge.kills;
      assert.strictEqual(stopped, 1, "the server stops the bridge after 15 seconds");
      yield* Fiber.join(closed);
    }),
  );

  it.effect("doesn't stop a bridge that exits once its input ends", () =>
    Effect.gen(function* () {
      const bridge = yield* fakeBridge({ readyLine: "printed", atEndOfInput: "exit" });
      yield* bridge.server.open(target).pipe(Effect.scoped);
      yield* bridge.inputEnded;
      yield* TestClock.adjust("15 seconds");
      const kills = yield* bridge.kills;
      assert.strictEqual(kills, 0);
    }),
  );
});
