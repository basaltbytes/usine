import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Result,
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
  environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
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
  readonly stdout: Queue.Queue<Uint8Array, Cause.Done>;
  readonly stderr: Queue.Queue<Uint8Array, Cause.Done>;
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  readonly stdinClosed: Deferred.Deferred<void>;
  readonly killed: Deferred.Deferred<void>;
  readonly stdinLines: Array<string>;
}

const fakeProcess = Effect.gen(function* () {
  return {
    stdout: yield* Queue.make<Uint8Array, Cause.Done>(),
    stderr: yield* Queue.make<Uint8Array, Cause.Done>(),
    exit: yield* Deferred.make<ChildProcessSpawner.ExitCode>(),
    stdinClosed: yield* Deferred.make<void>(),
    killed: yield* Deferred.make<void>(),
    stdinLines: [],
  } satisfies FakeProcess;
});

const spawnerFor = (
  process: FakeProcess,
  options: { readonly exitOnEof?: boolean; readonly stdout?: Stream.Stream<Uint8Array> } = {},
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        yield* Deferred.await(process.exit).pipe(
          Effect.andThen(Queue.end(process.stdout)),
          Effect.andThen(Queue.end(process.stderr)),
          Effect.forkScoped,
        );
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
            Effect.andThen(Deferred.succeed(process.stdinClosed, undefined)),
            Effect.andThen(
              options.exitOnEof === false
                ? Effect.void
                : Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0)),
            ),
            Effect.forkScoped,
          );
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Deferred.await(process.exit),
          isRunning: Deferred.isDone(process.exit).pipe(Effect.map((exited) => !exited)),
          kill: () =>
            Deferred.succeed(process.killed, undefined).pipe(
              Effect.andThen(Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(137))),
              Effect.asVoid,
            ),
          stdin: Sink.drain,
          stdout: options.stdout ?? Stream.fromQueue(process.stdout),
          stderr: Stream.fromQueue(process.stderr),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

/** Waits until the transport has written `count` stdin lines. */
const awaitStdinLines = (process: FakeProcess, count: number) =>
  Effect.gen(function* () {
    while (process.stdinLines.length < count) yield* Effect.yieldNow;
  });

describe("Codex app-server transport", () => {
  it.effect("sends EOF and keeps every close caller waiting until the process exits", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: Option.some(request.environment),
          });
          const first = yield* Effect.forkChild(connection.close);
          yield* Deferred.await(process.stdinClosed);
          const concurrent = yield* Effect.forkChild(connection.close);
          yield* TestClock.adjust(0);
          assert.strictEqual(first.pollUnsafe(), undefined, "EOF alone is not process exit");
          assert.strictEqual(concurrent.pollUnsafe(), undefined, "concurrent callers must wait");
          assert.strictEqual(yield* Deferred.isDone(process.killed), false);

          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0));
          yield* Fiber.join(first);
          yield* Fiber.join(concurrent);
          yield* connection.close;
        }).pipe(Effect.ensuring(Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0)))),
      ).pipe(
        Effect.provide(codexAppServerLive),
        Effect.provide(spawnerFor(process, { exitOnEof: false })),
      );
    }),
  );

  it.effect("stops a process that ignores EOF so its owning scope can close", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      const scoped = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: Option.some(request.environment),
          });
          return yield* Effect.flip(connection.close);
        }),
      ).pipe(
        Effect.provide(codexAppServerLive),
        Effect.provide(spawnerFor(process, { exitOnEof: false })),
        Effect.forkChild,
      );
      yield* Deferred.await(process.stdinClosed);
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(scoped);
      assert(error instanceof SessionOperationError);
      assert.strictEqual(yield* Deferred.isDone(process.killed), true);
      assert.strictEqual(yield* Deferred.isDone(process.exit), true);
    }),
  );

  it.effect("settles unanswered requests when the server closes", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: Option.some(request.environment),
          });
          const pending = yield* connection
            .request("steer", "turn/steer", {})
            .pipe(Effect.result, Effect.forkChild);
          yield* awaitStdinLines(process, 1);
          yield* connection.close;
          yield* TestClock.adjust(0);
          assert.notStrictEqual(
            pending.pollUnsafe(),
            undefined,
            "a closed server cannot answer the request",
          );
          const outcome = yield* Fiber.join(pending);
          assert(Result.isFailure(outcome));
          assert(outcome.failure instanceof SessionOperationError);
          assert.strictEqual(outcome.failure.operation, "steer");
        }),
      ).pipe(Effect.provide(codexAppServerLive), Effect.provide(spawnerFor(process)));
    }),
  );

  it.effect("reports an unsuccessful shutdown as a typed close failure", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: Option.some(request.environment),
          });
          const closing = yield* connection.close.pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(process.stdinClosed);
          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(2));
          const outcome = yield* Fiber.join(closing);
          assert(Result.isFailure(outcome));
          assert(outcome.failure instanceof SessionOperationError);
        }),
      ).pipe(
        Effect.provide(codexAppServerLive),
        Effect.provide(spawnerFor(process, { exitOnEof: false })),
      );
    }),
  );

  it.effect("delivers buffered replies before rejecting unanswered requests at shutdown", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      const readOutput = yield* Deferred.make<void>();
      const stdout = Stream.unwrap(
        Deferred.await(readOutput).pipe(Effect.as(Stream.fromQueue(process.stdout))),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: Option.some(request.environment),
          });
          const replied = yield* Effect.forkChild(connection.request("steer", "turn/steer", {}));
          const unanswered = yield* connection
            .request("interrupt", "turn/interrupt", {})
            .pipe(Effect.result, Effect.forkChild);
          yield* awaitStdinLines(process, 2);
          const sent: unknown = JSON.parse(process.stdinLines[0] ?? "");
          assert(Schema.is(Schema.Struct({ id: Schema.Int }))(sent));
          yield* Queue.offer(process.stdout, line({ id: sent.id, result: { accepted: true } }));

          const closing = yield* Effect.forkChild(connection.close);
          yield* Deferred.await(process.exit);
          yield* TestClock.adjust(0);
          assert.strictEqual(closing.pollUnsafe(), undefined, "stdout still holds a reply");
          yield* Deferred.succeed(readOutput, undefined);
          yield* Fiber.join(closing);
          assert.deepStrictEqual(yield* Fiber.join(replied), { accepted: true });
          const outcome = yield* Fiber.join(unanswered);
          assert(Result.isFailure(outcome));
          assert(outcome.failure instanceof SessionOperationError);
          assert.strictEqual(outcome.failure.operation, "interrupt");
        }).pipe(Effect.ensuring(Deferred.succeed(readOutput, undefined))),
      ).pipe(Effect.provide(codexAppServerLive), Effect.provide(spawnerFor(process, { stdout })));
    }),
  );

  it("starts outside the worktree with repository trust and recursive agents disabled", () => {
    const command = codexAppServerCommand("/workspace/repo", Option.some(request.environment));
    assert.strictEqual(command._tag, "StandardCommand");
    if (command._tag !== "StandardCommand") return;
    assert.notStrictEqual(command.options.cwd, "/workspace/repo");
    assert.deepStrictEqual(command.options.env, request.environment);
    assert.strictEqual(command.options.extendEnv, false);
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

  it("inherits this process's environment only when no environment is given", () => {
    const command = codexAppServerCommand("/workspace/repo", Option.none());
    assert.strictEqual(command._tag, "StandardCommand");
    if (command._tag !== "StandardCommand") return;
    assert.strictEqual(command.options.env, undefined);
  });

  it.effect("skips blank, malformed, and unknown-shaped lines instead of failing", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: Option.some(request.environment),
          });
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
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: Option.some(request.environment),
          });
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
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: Option.some(request.environment),
          });
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
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: Option.some(request.environment),
          });
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
