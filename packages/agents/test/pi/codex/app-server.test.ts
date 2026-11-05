import { jsonKey } from "@usine/core/json-key";
import { assert, describe, it } from "@effect/vitest";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import { WorkerName } from "@usine/core/worker";
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import {
  childPidFile,
  type ChildHost,
  LocalProcess,
  RemoteShell,
} from "../../../src/child-host/child-host.ts";
import {
  ChildRequest,
  ChildSessionLifecycle,
  SessionOperationError,
  WorkingDirectory,
} from "../../../src/runtime.ts";
import {
  CodexAppServer,
  codexAppServerCommand,
  codexAppServerLive,
} from "../../../src/harness/codex/app-server.ts";

const request = ChildRequest.make({
  worker: WorkerName.make("worker-1"),
  machine: Option.none(),
  environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
  host: LocalProcess.make(),
  session: ChildSession.make({
    id: AgentSessionId.make("parent:attempt-1:child:2"),
    parentId: AgentSessionId.make("parent:attempt-1"),
    agent: AgentName.make("developer"),
    brain: BrainSpec.make({
      harness: Harness.make("codex"),
      model: ModelId.make("gpt-5.6-terra"),
      effort: "medium",
    }),
  }),
  cwd: WorkingDirectory.make("/workspace/repo"),
  prompt: "Implement the focused task.",
});

const encoder = new TextEncoder();
const line = (value: Schema.Json): Uint8Array => encoder.encode(`${jsonKey(value)}\n`);

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

const awaitStdinLines = (process: FakeProcess, count: number) =>
  Effect.gen(function* () {
    while (process.stdinLines.length < count) yield* Effect.yieldNow;
  });

describe("Codex app-server transport", () => {
  it.effect("leaves the app-server for recovery when its attempt is stopping", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      const stopping = yield* Deferred.make<void>();
      const released = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* (yield* CodexAppServer).open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: request.environment,
            host: request.host,
          });
          yield* Deferred.succeed(stopping, undefined);
          yield* connection.close;
        }),
      ).pipe(
        Effect.provide(
          codexAppServerLive.pipe(Layer.provide(spawnerFor(process, { exitOnEof: false }))),
        ),
        Effect.provideService(ChildSessionLifecycle, { isStopping: Deferred.isDone(stopping) }),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(released);
      const stdinClosed = yield* Deferred.isDone(process.stdinClosed);
      const killed = yield* Deferred.isDone(process.killed);
      assert.isFalse(stdinClosed);
      assert.isFalse(killed);
    }),
  );

  for (const exitCode of [143, 255]) {
    it.effect(
      `leaves the remote supervisor alone after shutdown closes its relay with ${exitCode}`,
      () =>
        Effect.gen(function* () {
          const process = yield* fakeProcess;
          const stopping = yield* Deferred.make<void>();
          const errors: unknown[] = [];
          let spawns = 0;
          const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
            if (["WARN", "ERROR"].includes(logLevel.toUpperCase())) errors.push(message);
          });
          const spawner = Layer.effect(
            ChildProcessSpawner.ChildProcessSpawner,
            Effect.gen(function* () {
              const base = yield* ChildProcessSpawner.ChildProcessSpawner;
              return ChildProcessSpawner.make((command) => {
                spawns += 1;
                return base.spawn(command);
              });
            }),
          ).pipe(Layer.provide(spawnerFor(process, { exitOnEof: false })));
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* (yield* CodexAppServer).open({
                cwd: request.cwd,
                sessionId: Option.some(request.session.id),
                environment: request.environment,
                host: RemoteShell.make({
                  ssh: { command: "ssh", args: [] },
                  sshEnvironment: {},
                  destination: "worker",
                }),
              });
              yield* TestClock.adjust(0);
              yield* Deferred.succeed(stopping, undefined);
              yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(exitCode));
              yield* TestClock.adjust("1 minute");
            }),
          ).pipe(
            Effect.provide(codexAppServerLive.pipe(Layer.provide(spawner))),
            Effect.provideService(ChildSessionLifecycle, { isStopping: Deferred.isDone(stopping) }),
            Effect.provide(Logger.layer([logger])),
          );
          assert.strictEqual(spawns, 1);
          const killed = yield* Deferred.isDone(process.killed);
          assert.isFalse(killed);
          assert.deepStrictEqual(errors, []);
        }),
    );
  }

  it.effect("stops both retained remote app-servers before replacing the transport", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      const attached = yield* Deferred.make<{
        live: ReadonlyArray<string>;
        journals: ReadonlyArray<string>;
      }>();
      const stopping = yield* Deferred.make<void>();
      const original = childPidFile(request.cwd, request.session.id);
      const resumed = childPidFile(
        request.cwd,
        AgentSessionId.make(`${request.session.id}-resume`),
      );
      const live = new Set([original, resumed]);
      const journals = new Set([original, resumed]);
      const spawner = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const base = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              assert.strictEqual(command._tag, "StandardCommand");
              if (command._tag !== "StandardCommand") return yield* base.spawn(command);
              const shell = command.args.at(-1) ?? "";
              for (const pidFile of [original, resumed]) {
                for (const mode of ["stop", "remove"]) {
                  if (!shell.includes(`'${mode}' '${pidFile}' '0'`)) continue;
                  if (mode === "stop") live.delete(pidFile);
                  else {
                    assert.isFalse(
                      live.has(pidFile),
                      "a live supervisor must stop before journal removal",
                    );
                    journals.delete(pidFile);
                  }

                  return ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(4243),
                    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                    isRunning: Effect.succeed(false),
                    kill: () => Effect.void,
                    stdin: Sink.drain,
                    stdout: Stream.empty,
                    stderr: Stream.empty,
                    all: Stream.empty,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                    unref: Effect.succeed(Effect.void),
                  });
                }
              }
              yield* Deferred.succeed(attached, { live: [...live], journals: [...journals] });
              return yield* base.spawn(command);
            }),
          );
        }),
      ).pipe(Layer.provide(spawnerFor(process, { exitOnEof: false })));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* CodexAppServer).open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: request.environment,
            host: RemoteShell.make({
              ssh: { command: "ssh", args: [] },
              sshEnvironment: {},
              destination: "worker",
            }),
            transport: "replace",
          });
          const retained = yield* Deferred.await(attached);
          yield* Deferred.succeed(stopping, undefined);
          assert.deepStrictEqual(retained.live, [], "replacement must stop both app-servers");
          assert.deepStrictEqual(retained.journals, [], "replacement must remove both transports");
        }),
      ).pipe(
        Effect.provide(codexAppServerLive.pipe(Layer.provide(spawner))),
        Effect.provideService(ChildSessionLifecycle, { isStopping: Deferred.isDone(stopping) }),
      );
    }),
  );

  it.effect("sends EOF and keeps every close caller waiting until the process exits", () =>
    Effect.gen(function* () {
      const process = yield* fakeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* CodexAppServer;
          const connection = yield* server.open({
            cwd: request.cwd,
            sessionId: Option.some(request.session.id),
            environment: request.environment,
            host: request.host,
          });
          const first = yield* Effect.forkChild(connection.close);
          yield* Deferred.await(process.stdinClosed);
          const concurrent = yield* Effect.forkChild(connection.close);
          yield* TestClock.adjust(0);
          assert.strictEqual(first.pollUnsafe(), undefined, "EOF alone is not process exit");
          assert.strictEqual(concurrent.pollUnsafe(), undefined, "concurrent callers must wait");
          const killedDone = yield* Deferred.isDone(process.killed);
          assert.strictEqual(killedDone, false);

          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0));
          yield* Fiber.join(first);
          yield* Fiber.join(concurrent);
          yield* connection.close;
        }).pipe(Effect.ensuring(Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(0)))),
      ).pipe(
        Effect.provide(
          codexAppServerLive.pipe(Layer.provideMerge(spawnerFor(process, { exitOnEof: false }))),
        ),
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
            environment: request.environment,
            host: request.host,
          });
          return yield* Effect.flip(connection.close);
        }),
      ).pipe(
        Effect.provide(
          codexAppServerLive.pipe(Layer.provideMerge(spawnerFor(process, { exitOnEof: false }))),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(process.stdinClosed);
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(scoped);
      const matchesError = Schema.is(SessionOperationError)(error);
      assert(matchesError);
      const killedDone = yield* Deferred.isDone(process.killed);
      assert.strictEqual(killedDone, true);
      const exitDone = yield* Deferred.isDone(process.exit);
      assert.strictEqual(exitDone, true);
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
            environment: request.environment,
            host: request.host,
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
          const matchesOutcomeFailure = Schema.is(SessionOperationError)(outcome.failure);
          assert(matchesOutcomeFailure);
          assert.strictEqual(outcome.failure.operation, "steer");
        }),
      ).pipe(Effect.provide(codexAppServerLive.pipe(Layer.provideMerge(spawnerFor(process)))));
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
            environment: request.environment,
            host: request.host,
          });
          const closing = yield* connection.close.pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(process.stdinClosed);
          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(2));
          const outcome = yield* Fiber.join(closing);
          assert(Result.isFailure(outcome));
          const matchesOutcomeFailure = Schema.is(SessionOperationError)(outcome.failure);
          assert(matchesOutcomeFailure);
        }),
      ).pipe(
        Effect.provide(
          codexAppServerLive.pipe(Layer.provideMerge(spawnerFor(process, { exitOnEof: false }))),
        ),
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
            environment: request.environment,
            host: request.host,
          });
          const replied = yield* Effect.forkChild(connection.request("steer", "turn/steer", {}));
          const unanswered = yield* connection
            .request("interrupt", "turn/interrupt", {})
            .pipe(Effect.result, Effect.forkChild);
          yield* awaitStdinLines(process, 2);
          const json1 = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
            process.stdinLines[0] ?? "",
          ).pipe(Effect.orDie);
          const sent: unknown = json1;
          assert(Schema.is(Schema.Struct({ id: Schema.Int }))(sent));
          yield* Queue.offer(process.stdout, line({ id: sent.id, result: { accepted: true } }));

          const closing = yield* Effect.forkChild(connection.close);
          yield* Deferred.await(process.exit);
          yield* TestClock.adjust(0);
          assert.strictEqual(closing.pollUnsafe(), undefined, "stdout still holds a reply");
          yield* Deferred.succeed(readOutput, undefined);
          yield* Fiber.join(closing);
          const repliedResult = yield* Fiber.join(replied);
          assert.deepStrictEqual(repliedResult, { accepted: true });
          const outcome = yield* Fiber.join(unanswered);
          assert(Result.isFailure(outcome));
          const matchesOutcomeFailure = Schema.is(SessionOperationError)(outcome.failure);
          assert(matchesOutcomeFailure);
          assert.strictEqual(outcome.failure.operation, "interrupt");
        }).pipe(Effect.ensuring(Deferred.succeed(readOutput, undefined))),
      ).pipe(
        Effect.provide(
          codexAppServerLive.pipe(Layer.provideMerge(spawnerFor(process, { stdout }))),
        ),
      );
    }),
  );

  const client = (host: ChildHost, environment = request.environment) => ({
    cwd: request.cwd,
    sessionId: Option.some(request.session.id),
    environment,
    host,
  });

  for (const sessionId of [Option.some(request.session.id), Option.none<AgentSessionId>()]) {
    it(`disables repository trust, recursive agents, and background traffic for ${Option.isSome(sessionId) ? "children" : "preflight"}`, () => {
      const command = codexAppServerCommand({ ...client(LocalProcess.make()), sessionId });
      assert.strictEqual(command._tag, "StandardCommand");
      if (command._tag !== "StandardCommand") return;
      assert.strictEqual(command.options.cwd, "/");
      assert.deepStrictEqual(command.options.env, request.environment);
      assert.strictEqual(command.options.extendEnv, false);
      assert.strictEqual(command.options.detached, false);
      assert.strictEqual(command.options.forceKillAfter, "5 seconds");
      assert.deepStrictEqual(command.args, [
        "app-server",
        "--stdio",
        "-c",
        'projects={"/workspace/repo"={trust_level="untrusted"}}',
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.plugins=false",
        "-c",
        "features.remote_plugin=false",
        "-c",
        "features.apps=false",
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        "analytics.enabled=false",
        "-c",
        'cli_auth_credentials_store="file"',
      ]);
    });
  }

  it("runs the app server on a remote host as one SSH command with its pid recorded", () => {
    const host = RemoteShell.make({
      ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
      sshEnvironment: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
      destination: "worker.exe.xyz",
    });
    const stdin = { stream: Stream.empty, endOnDone: true };
    const command = codexAppServerCommand(client(host, { GH_HOST: "github.int.exe.xyz" }), stdin);
    assert.strictEqual(command._tag, "StandardCommand");
    if (command._tag !== "StandardCommand") return;
    assert.strictEqual(command.command, "ssh");
    assert.deepStrictEqual(command.args, [
      "-o",
      "BatchMode=yes",
      "worker.exe.xyz",
      "--",
      `cd '/' && export GH_HOST='github.int.exe.xyz' && sh -c 'printf %s "$$" > "$0" && exec "$@"' '/workspace/repo.child-2.pid' 'codex' 'app-server' '--stdio' '-c' 'projects={"/workspace/repo"={trust_level="untrusted"}}' '-c' 'features.multi_agent=false' '-c' 'features.plugins=false' '-c' 'features.remote_plugin=false' '-c' 'features.apps=false' '-c' 'check_for_update_on_startup=false' '-c' 'analytics.enabled=false'; code=$?; rm -f '/workspace/repo.child-2.pid'; exit "$code"`,
    ]);
    assert.deepStrictEqual(command.options.env, host.sshEnvironment);
    assert.strictEqual(command.options.extendEnv, false);
    assert.strictEqual(command.options.cwd, undefined);
    assert.strictEqual(command.options.stdin, stdin);
    assert.strictEqual(command.options.forceKillAfter, "5 seconds");
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
            environment: request.environment,
            host: request.host,
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
      ).pipe(Effect.provide(codexAppServerLive.pipe(Layer.provideMerge(spawnerFor(process)))));
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
            environment: request.environment,
            host: request.host,
          });
          const notifications = yield* Effect.forkChild(Stream.runHead(connection.notifications));
          yield* Queue.offer(process.stdout, line({ id: 9, method: "item/approval" }));
          yield* Queue.offer(process.stdout, line({ method: "turn/started", params: {} }));
          yield* awaitStdinLines(process, 1);
          const json2 = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
            process.stdinLines[0] ?? "",
          ).pipe(Effect.orDie);
          const written: unknown = json2;
          assert.deepStrictEqual(written, {
            id: 9,
            error: { code: -32601, message: "usine runs Codex headlessly" },
          });
          const first = yield* Fiber.join(notifications);
          assert.deepStrictEqual(first, Option.some({ method: "turn/started", params: {} }));
        }),
      ).pipe(Effect.provide(codexAppServerLive.pipe(Layer.provideMerge(spawnerFor(process)))));
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
            environment: request.environment,
            host: request.host,
          });
          yield* Queue.offer(process.stderr, encoder.encode("codex: no login found\n"));
          const pending = yield* Effect.forkChild(connection.request("launch", "initialize", {}));
          yield* awaitStdinLines(process, 1);
          yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(1));
          const error = yield* Effect.flip(Fiber.join(pending));
          const matchesError = Schema.is(SessionOperationError)(error);
          assert(matchesError);
          assert.match(error.message, /exited with code 1/u);
          assert.deepStrictEqual(error.cause, {
            exitCode: 1,
            stderr: ["codex: no login found"],
          });

          const afterFailure = yield* Effect.flip(connection.request("steer", "turn/steer", {}));
          assert.strictEqual(afterFailure, error, "later requests preserve the recorded failure");
        }),
      ).pipe(Effect.provide(codexAppServerLive.pipe(Layer.provideMerge(spawnerFor(process)))));
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
            environment: request.environment,
            host: request.host,
          });
          const pending = yield* Effect.forkChild(connection.request("launch", "initialize", {}));
          yield* awaitStdinLines(process, 1);
          yield* TestClock.adjust("61 seconds");
          const error = yield* Effect.flip(Fiber.join(pending));
          const matchesError = Schema.is(SessionOperationError)(error);
          assert(matchesError);
          assert.match(error.message, /didn't respond to initialize/u);
        }),
      ).pipe(Effect.provide(codexAppServerLive.pipe(Layer.provideMerge(spawnerFor(process)))));
    }),
  );
});
