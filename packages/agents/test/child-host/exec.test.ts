import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import {
  type Cause,
  Deferred,
  Effect,
  Exit,
  Option,
  Queue,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ExecShell, type ExecTransport, HostUnreachable } from "../../src/child-host/child-host.ts";
import { hostOutput, hostSpawn } from "../../src/child-host/command.ts";
import { unreachableCause } from "../../src/child-host/exec.ts";
import { startChildProcess } from "../../src/child-host/node.ts";
import { ChildSessionLifecycle } from "../../src/runtime.ts";

const encoder = new TextEncoder();

/** A transport that runs each command line with the local `sh -c` and records the lines. */
const localTransport = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lines: Array<string> = [];
  const transport: ExecTransport = {
    run: (line, stdin) =>
      Effect.gen(function* () {
        lines.push(line);
        const handle = yield* spawner
          .spawn(ChildProcess.make("sh", ["-c", line], { stdin }))
          .pipe(Effect.orDie);
        return {
          stdout: handle.stdout.pipe(Stream.orDie),
          stderr: handle.stderr.pipe(Stream.orDie),
          exitCode: handle.exitCode.pipe(Effect.orDie, Effect.map(Number)),
        };
      }),
  };
  return { transport, lines };
});

/** A frame that the process owner relay writes to its stdout. */
const encodeOwnerFrame = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
  ),
);

/** Decodes a line of the relay's stdin: an input frame, a heartbeat, or the environment block. */
const decodeInputFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.optionalKey(Schema.String),
      eof: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

const lost = HostUnreachable.make({ destination: "vm-1", message: "the stream was reset" });

describe("exec shell", () => {
  it.live("runs a command through its transport with secrets on stdin, not in the line", () =>
    Effect.gen(function* () {
      const { transport, lines } = yield* localTransport;
      const secret = "it's $HOME; $(exit 9)";
      const host = ExecShell.make({
        transport,
        destination: "vm-1",
        stdinEnvironment: { USINE_SECRET: Redacted.make(secret) },
      });
      const output = yield* hostOutput(host, {
        cwd: "/",
        environment: {},
        command: "sh",
        args: ["-c", 'printf "%s|%s" "$USINE_SECRET" "$(pwd)"'],
      });
      assert.deepStrictEqual(output, { stdout: `${secret}|/`, exitCode: 0 });
      assert.lengthOf(lines, 1);
      assert.notInclude(lines[0] ?? "", secret);
      const failed = yield* hostOutput(host, { environment: {}, command: "false", args: [] });
      assert.strictEqual(failed.exitCode, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps the output that arrived before the transport lost the command, then fails with HostUnreachable",
    () =>
      Effect.gen(function* () {
        const diagnostics = Array.from({ length: 8 }, (_, index) => `diag ${index}\n`);
        const host = ExecShell.make({
          destination: "vm-1",
          transport: {
            run: () =>
              Effect.succeed({
                stdout: Stream.make(encoder.encode("partial")),
                stderr: Stream.fromIterable(diagnostics.map((text) => encoder.encode(text))),
                exitCode: Effect.fail(lost),
              }),
          },
        });
        const handle = yield* hostSpawn(host, { environment: {}, command: "work", args: [] }, {});
        const [stdout, stderr] = yield* Effect.all([
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ]);
        assert.strictEqual(stdout, "partial");
        assert.strictEqual(stderr, diagnostics.join(""));
        const exit = yield* handle.exitCode.pipe(Effect.flip);
        assert.deepStrictEqual(unreachableCause(exit), Option.some(lost));
        const output = yield* hostOutput(host, { environment: {}, command: "work", args: [] }).pipe(
          Effect.flip,
        );
        assert.deepStrictEqual(output, lost);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels the command when killed and reports exit code 143", () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>();
      const host = ExecShell.make({
        destination: "vm-1",
        transport: {
          run: () =>
            Effect.addFinalizer(() => Deferred.succeed(cancelled, undefined)).pipe(
              Effect.as({ stdout: Stream.never, stderr: Stream.never, exitCode: Effect.never }),
            ),
        },
      });
      const handle = yield* hostSpawn(
        host,
        { environment: {}, command: "sleep", args: ["60"] },
        {},
      );
      const running = yield* handle.isRunning;
      assert.isTrue(running);
      yield* handle.kill();
      yield* Deferred.await(cancelled);
      const exitCode = yield* handle.exitCode;
      assert.strictEqual(exitCode, ChildProcessSpawner.ExitCode(143));
      const stillRunning = yield* handle.isRunning;
      assert.isFalse(stillRunning);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "keeps the process owner's stdin open after a finite input ends, so its exit event arrives",
    () =>
      Effect.gen(function* () {
        let stdinEnded = false;
        // Answers like the owner relay, which exits without an exit event when its stdin closes.
        const transport: ExecTransport = {
          run: (line, stdin) =>
            Effect.gen(function* () {
              if (line.includes("'stop'") || line.includes("'remove'"))
                return { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) };
              const frames = yield* Queue.unbounded<Uint8Array, Cause.Done>();
              const emit = (frame: Readonly<Record<string, string | number | boolean>>) =>
                encodeOwnerFrame(frame).pipe(
                  Effect.orDie,
                  Effect.flatMap((line) => Queue.offer(frames, encoder.encode(`${line}\n`))),
                );
              let offset = 0;
              yield* emit({ offset, ready: true, sequence: 0, retained: false });
              yield* stdin.pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach((text) =>
                  decodeInputFrame(text).pipe(
                    Effect.orDie,
                    Effect.flatMap((frame) => {
                      if (frame.data !== undefined) {
                        offset += Buffer.from(frame.data, "base64").length;
                        return emit({ offset, stdout: frame.data });
                      }
                      if (frame.eof !== true) return Effect.void;
                      return Effect.sleep("200 millis").pipe(
                        Effect.andThen(emit({ offset, exitCode: 0, stderrTail: "" })),
                        Effect.andThen(Queue.end(frames)),
                        Effect.forkScoped,
                      );
                    }),
                  ),
                ),
                Effect.andThen(
                  Effect.sync(() => {
                    stdinEnded = true;
                  }),
                ),
                Effect.andThen(Queue.end(frames)),
                Effect.forkScoped,
              );
              return {
                stdout: Stream.fromQueue(frames),
                stderr: Stream.empty,
                exitCode: Effect.succeed(0),
              };
            }),
        };
        const scope = yield* Scope.make();
        const owner = yield* startChildProcess(
          {
            host: ExecShell.make({ transport, destination: "vm-1" }),
            cwd: "/worktree",
            environment: {},
            sessionId: Option.some(AgentSessionId.make("attempt:child:1")),
          },
          { command: "cat", args: [], cwd: "/worktree" },
          Stream.make(encoder.encode("hello")),
        ).pipe(
          Effect.provideService(ChildSessionLifecycle, { isStopping: Effect.succeed(false) }),
          Scope.provide(scope),
        );
        const received = yield* owner.stdout.pipe(Stream.decodeText(), Stream.mkString);
        const exited = yield* owner.exit.pipe(Effect.timeout("5 seconds"));
        assert.strictEqual(received, "hello");
        assert.strictEqual(exited.exitCode, 0);
        assert.isFalse(stdinEnded, "the owner's stdin stayed open after the input ended");
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reattaches the process owner after the transport loses it", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const ready = encoder.encode('{"offset":0,"ready":true,"sequence":0,"retained":false}\n');
      const hello = encoder.encode(
        `{"offset":5,"stdout":"${Buffer.from("hello").toString("base64")}"}\n`,
      );
      const transport: ExecTransport = {
        run: (line, stdin) =>
          Effect.gen(function* () {
            // Stopping the owner when the test ends.
            if (line.includes("'stop'") || line.includes("'remove'"))
              return { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) };
            lines.push(line);
            yield* stdin.pipe(Stream.runDrain, Effect.forkScoped);
            if (lines.length === 1)
              return {
                stdout: Stream.make(ready),
                stderr: Stream.empty,
                exitCode: Effect.fail(lost),
              };
            return {
              stdout: Stream.make(ready, hello).pipe(Stream.concat(Stream.never)),
              stderr: Stream.empty,
              exitCode: Effect.never,
            };
          }),
      };
      const scope = yield* Scope.make();
      const owner = yield* startChildProcess(
        {
          host: ExecShell.make({ transport, destination: "vm-1" }),
          cwd: "/worktree",
          environment: {},
          sessionId: Option.some(AgentSessionId.make("attempt:child:1")),
        },
        { command: "claude", args: [], cwd: "/worktree" },
        Stream.never,
      ).pipe(
        Effect.provideService(ChildSessionLifecycle, { isStopping: Effect.succeed(false) }),
        Scope.provide(scope),
      );
      const received = yield* owner.stdout.pipe(
        Stream.take(1),
        Stream.decodeText(),
        Stream.mkString,
      );
      assert.strictEqual(received, "hello");
      assert.lengthOf(lines, 2);
      assert.include(lines[0] ?? "", "'replace'");
      assert.include(lines[1] ?? "", "'attach'");
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
