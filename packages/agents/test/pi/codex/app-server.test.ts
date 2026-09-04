import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AgentName } from "@usine/core/ids";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ChildRequest, SessionOperationError, WorkingDirectory } from "../../../src/runtime.ts";
import {
  CodexAppServer,
  codexAppServerCommand,
  codexAppServerLive,
} from "../../../src/pi/codex/app-server.ts";

const request = new ChildRequest({
  session: new ChildSession({
    id: AgentSessionId.make("codex-child-1"),
    parentId: AgentSessionId.make("parent-1"),
    agent: AgentName.make("developer"),
    brain: new BrainSpec({
      harness: "codex",
      model: ModelId.make("gpt-5.6-terra"),
      effort: "medium",
    }),
  }),
  cwd: WorkingDirectory.make("/workspace/repo"),
  prompt: "Implement the focused task.",
});

const encoder = new TextEncoder();
const line = (value: Schema.Json): Uint8Array => encoder.encode(`${JSON.stringify(value)}\n`);

interface FakeProcess {
  readonly stdout: Queue.Queue<Uint8Array>;
  readonly stderr: Queue.Queue<Uint8Array>;
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  readonly stdinLines: Array<string>;
}

const fakeProcess = Effect.gen(function* () {
  return {
    stdout: yield* Queue.make<Uint8Array>(),
    stderr: yield* Queue.make<Uint8Array>(),
    exit: yield* Deferred.make<ChildProcessSpawner.ExitCode>(),
    stdinLines: [],
  } satisfies FakeProcess;
});

const spawnerFor = (process: FakeProcess) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (
          command._tag === "StandardCommand" &&
          Predicate.hasProperty(command.options.stdin, "stream") &&
          Stream.isStream(command.options.stdin.stream)
        ) {
          yield* command.options.stdin.stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((written) =>
              Effect.sync(() => {
                process.stdinLines.push(written);
              }),
            ),
            Effect.ignore,
            Effect.forkScoped,
          );
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Deferred.await(process.exit),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.fromQueue(process.stdout),
          stderr: Stream.fromQueue(process.stderr),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

/** Yields until the transport has written `count` stdin lines. */
const awaitStdinLines = (process: FakeProcess, count: number) =>
  Effect.gen(function* () {
    while (process.stdinLines.length < count) yield* Effect.yieldNow;
  });

describe("Codex app-server transport", () => {
  it("starts outside the worktree with repository trust and recursive agents disabled", () => {
    const command = codexAppServerCommand("/workspace/repo");
    assert.strictEqual(command._tag, "StandardCommand");
    if (command._tag !== "StandardCommand") return;
    assert.notStrictEqual(command.options.cwd, "/workspace/repo");
    assert.strictEqual(command.options.detached, false);
    assert.strictEqual(command.options.forceKillAfter, "5 seconds");
    assert.deepStrictEqual(command.args, [
      "app-server",
      "--stdio",
      "-c",
      'projects."/workspace/repo".trust_level="untrusted"',
      "-c",
      "features.multi_agent=false",
    ]);
  });

  it.effect("skips blank, malformed, and unknown-shaped lines instead of failing", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open(request);
          const pending = yield* Effect.forkChild(connection.request("launch", "initialize", {}));
          yield* awaitStdinLines(process, 1);
          yield* Queue.offer(process.stdout, encoder.encode("\n"));
          yield* Queue.offer(process.stdout, encoder.encode("{not json\n"));
          yield* Queue.offer(process.stdout, line({ unexpected: "shape" }));
          yield* Queue.offer(process.stdout, line({ id: 1, result: { userAgent: "codex" } }));
          const result = yield* Fiber.join(pending);
          assert.deepStrictEqual(result, { userAgent: "codex" });
        }),
      ).pipe(Effect.provide(codexAppServerLive), Effect.provide(spawnerFor(process)));
    }),
  );

  it.effect("refuses server-initiated requests instead of stalling headless runs", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open(request);
          const notifications = yield* Effect.forkChild(Stream.runHead(connection.notifications));
          yield* Queue.offer(process.stdout, line({ id: 9, method: "item/approval" }));
          yield* Queue.offer(process.stdout, line({ method: "turn/started", params: {} }));
          yield* awaitStdinLines(process, 1);
          const written: unknown = JSON.parse(process.stdinLines[0] ?? "");
          assert.deepStrictEqual(written, {
            id: 9,
            error: { code: -32601, message: "usine runs Codex headlessly" },
          });
          const first = yield* Fiber.join(notifications);
          assert.deepStrictEqual(first, Option.some({ method: "turn/started", params: {} }));
        }),
      ).pipe(Effect.provide(codexAppServerLive), Effect.provide(spawnerFor(process)));
    }),
  );

  it.effect("fails pending requests with the exit code and captured stderr", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open(request);
          yield* Queue.offer(process.stderr, encoder.encode("codex: no login found\n"));
          const pending = yield* Effect.forkChild(connection.request("launch", "initialize", {}));
          yield* awaitStdinLines(process, 1);
          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(1));
          const error = yield* Effect.flip(Fiber.join(pending));
          assert(error instanceof SessionOperationError);
          assert.match(error.message, /exited with code 1/u);
          assert.deepStrictEqual(error.cause, {
            exitCode: 1,
            stderr: ["codex: no login found"],
          });

          const afterFailure = yield* Effect.flip(connection.request("steer", "turn/steer", {}));
          assert(afterFailure instanceof SessionOperationError);
          assert.match(afterFailure.message, /already failed/u);
        }),
      ).pipe(Effect.provide(codexAppServerLive), Effect.provide(spawnerFor(process)));
    }),
  );

  it.effect("times out a request the app-server never answers", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open(request);
          const pending = yield* Effect.forkChild(connection.request("launch", "initialize", {}));
          yield* awaitStdinLines(process, 1);
          yield* TestClock.adjust("61 seconds");
          const error = yield* Effect.flip(Fiber.join(pending));
          assert(error instanceof SessionOperationError);
          assert.match(error.message, /did not answer initialize/u);
        }),
      ).pipe(Effect.provide(codexAppServerLive), Effect.provide(spawnerFor(process)));
    }),
  );
});
