import { Code, ConnectError } from "@connectrpc/connect";
import { assert, describe, it } from "@effect/vitest";
import { HostUnreachable } from "@usine/agents/child-host";
import { MachineId } from "@usine/core/worker";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Redacted,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { connect, createServer, type Socket } from "node:net";
import {
  BoxdExec,
  boxdExecLayer,
  boxdTransport,
  DEFAULT_KEEPALIVE,
  STDIN_CHUNK_BYTES,
} from "../../../../src/ssh/provisioner/boxd/exec.ts";
import { BoxdCallError } from "../../../../src/ssh/provisioner/boxd/client.ts";
import { type ExecHandler, fakeBoxdExec, runLocally } from "./fake-exec.ts";

const KEY = "bxd_exec_test_key";
/** Returns the `Exec` credential that always answers `credential`. */
const bearer = (credential: string) => Effect.succeed(Redacted.make(credential));
const MACHINE = MachineId.make("vm-exec-1");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Runs `command` on the fake through a fresh `BoxdExec`, collecting both streams to their end, then
 * the exit code or the error that ended the call.
 */
const collect = (
  url: string,
  command: string,
  stdin: Stream.Stream<Uint8Array> = Stream.empty,
  options: { readonly machine?: MachineId; readonly credential?: string } = {},
) =>
  Effect.gen(function* () {
    const exec = yield* BoxdExec;
    const execution = yield* exec.exec(options.machine ?? MACHINE, command, stdin);
    const [stdout, stderr] = yield* Effect.all(
      [execution.stdout.pipe(Stream.runCollect), execution.stderr.pipe(Stream.runCollect)],
      { concurrency: "unbounded" },
    );
    const join = (chunks: ReadonlyArray<Uint8Array>) => Buffer.concat(chunks);
    return {
      stdout: join(stdout),
      stderr: join(stderr),
      exitCode: yield* Effect.result(execution.exitCode),
    };
  }).pipe(Effect.scoped, Effect.provide(boxdExecLayer(url, bearer(options.credential ?? KEY))));

/** Runs `command` like `collect` and fails with the error that ended the call. */
const run = (...args: Parameters<typeof collect>) =>
  collect(...args).pipe(
    Effect.flatMap(({ exitCode, ...output }) =>
      Effect.map(Effect.fromResult(exitCode), (code) => ({ ...output, exitCode: code })),
    ),
  );

const fake = (handler: ExecHandler = runLocally) =>
  fakeBoxdExec({ credential: KEY, machines: new Set([MACHINE]), handler });

const replies =
  (
    ...chunks: ReadonlyArray<{ data?: string; isStderr?: boolean; exitCode?: number }>
  ): ExecHandler =>
  () =>
    Stream.fromIterable(
      chunks.map(({ data = "", ...rest }) => ({ ...rest, data: encoder.encode(data) })),
    );

const failing =
  (error: ConnectError): ExecHandler =>
  () =>
    Stream.die(error);

describe("BoxdExec", () => {
  it.live("relays stdout in order, keeps stderr apart, and returns the exit code", () =>
    Effect.gen(function* () {
      const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index}\n`);
      const server = yield* fake(
        replies(
          ...lines.flatMap((line, index) =>
            index % 100 === 0
              ? [{ data: line }, { data: `err ${index}\n`, isStderr: true }]
              : [{ data: line }],
          ),
          { exitCode: 7 },
        ),
      );
      const result = yield* run(server.url, "printf hi");

      assert.strictEqual(decoder.decode(result.stdout), lines.join(""));
      assert.strictEqual(
        decoder.decode(result.stderr),
        lines
          .map((_, index) => index)
          .filter((index) => index % 100 === 0)
          .map((index) => `err ${index}\n`)
          .join(""),
      );
      assert.strictEqual(result.exitCode, 7);
      const [call] = server.calls;
      assert.strictEqual(call?.machine, MACHINE);
      assert.strictEqual(call?.command, "printf hi");
      assert.strictEqual(call?.authorization, `Bearer ${KEY}`);
    }).pipe(Effect.scoped),
  );

  it.live("sends 5 MiB of stdin byte-exact in chunks that boxd keeps", () =>
    Effect.gen(function* () {
      const server = yield* fake();
      const input = Uint8Array.from({ length: 5 * 1024 * 1024 }, (_, index) => (index * 31) % 256);
      const result = yield* run(server.url, "cat", Stream.succeed(input));

      assert.strictEqual(result.exitCode, 0);
      assert.isTrue(Buffer.from(input).equals(result.stdout));
      const sizes = server.calls[0]?.stdinChunks ?? [];
      assert.isAbove(sizes.length, 1);
      assert.isAtMost(Math.max(...sizes), STDIN_CHUNK_BYTES);
    }).pipe(Effect.scoped),
  );

  it.live(
    "raises the HTTP/2 connection and stream windows to 8 MiB by the time the command starts",
    () =>
      Effect.gen(function* () {
        const connections: Array<number> = [];
        const streams: Array<number> = [];
        const server = yield* fakeBoxdExec({
          credential: KEY,
          machines: new Set([MACHINE]),
          handler: () =>
            Stream.sync(() => {
              for (const session of server.sessions) {
                connections.push(session.state.remoteWindowSize ?? 0);
                // The window that the client grants each new stream.
                streams.push(session.remoteSettings.initialWindowSize ?? 0);
              }
              return { exitCode: 0 };
            }),
        });
        yield* run(server.url, "true");

        assert.isAtLeast(Math.max(...connections), 8 * 1024 * 1024 - 1024);
        assert.isAtLeast(Math.max(...streams), 8 * 1024 * 1024);
      }).pipe(Effect.scoped),
  );

  it.live("maps each gRPC status to a typed error without the credential", () =>
    Effect.gen(function* () {
      const cases = [
        { error: new ConnectError("VM not found (region fra)", Code.NotFound), code: "NOT_FOUND" },
        {
          error: new ConnectError(
            "lost the connection to the machine during exec: the machine was destroyed",
            Code.Unavailable,
          ),
          code: "UNAVAILABLE",
        },
        { error: new ConnectError("read ETIMEDOUT", Code.Unavailable), code: "UNAVAILABLE" },
        {
          error: new ConnectError(`bad key ${KEY}`, Code.PermissionDenied),
          code: "PERMISSION_DENIED",
        },
      ];
      for (const { error, code } of cases) {
        const server = yield* fake(failing(error));
        const failure = yield* run(server.url, "true").pipe(Effect.flip);
        assert.strictEqual(failure.code, code, error.rawMessage);
        assert.strictEqual(failure.message, error.rawMessage.replaceAll(KEY, "[redacted]"));
      }
      const server = yield* fake();
      const refused = yield* run(server.url, "true", Stream.empty, { credential: "other" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(refused.code, "UNAUTHENTICATED");
      const unknown = yield* run(server.url, "true", Stream.empty, {
        machine: MachineId.make("vm-unknown"),
      }).pipe(Effect.flip);
      assert.strictEqual(unknown.code, "NOT_FOUND");
    }).pipe(Effect.scoped),
  );

  it.live("keeps the error message intact when the credential is empty", () =>
    Effect.gen(function* () {
      const server = yield* fake();
      const refused = yield* run(server.url, "true", Stream.empty, { credential: "" }).pipe(
        Effect.flip,
      );

      assert.strictEqual(refused.code, "UNAUTHENTICATED");
      assert.strictEqual(
        refused.message,
        "API key not recognized: it was deleted, or it is not a key of this cluster",
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps the output that boxd sent before the call failed", () =>
    Effect.gen(function* () {
      const diagnostics = Array.from({ length: 8 }, (_, index) => `diag ${index}\n`);
      const server = yield* fake(() =>
        Stream.fromIterable(
          diagnostics.map((text) => ({ data: encoder.encode(text), isStderr: true })),
        ).pipe(Stream.concat(Stream.die(new ConnectError("connection reset", Code.Unavailable)))),
      );
      for (let tries = 0; tries < 6; tries += 1) {
        const result = yield* collect(server.url, "true");
        assert.strictEqual(decoder.decode(result.stderr), diagnostics.join(""));
        assert(Result.isFailure(result.exitCode));
        assert(result.exitCode.failure._tag === "BoxdCallError");
        assert.strictEqual(result.exitCode.failure.code, "UNAVAILABLE");
      }
    }).pipe(Effect.scoped),
  );

  it.live("stops reading stdin when the command exits first", () =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      const server = yield* fake(replies({ exitCode: 0 }));
      const result = yield* run(
        server.url,
        "true",
        Stream.never.pipe(Stream.ensuring(Deferred.succeed(closed, undefined))),
      );
      assert.strictEqual(result.exitCode, 0);
      yield* Deferred.await(closed).pipe(Effect.timeout("2 seconds"));
    }).pipe(Effect.scoped),
  );

  it.live(
    "reports a refused credential, an unavailable endpoint, and a deleted machine as HostUnreachable through its transport",
    () =>
      Effect.gen(function* () {
        const unavailable = yield* fake(
          failing(new ConnectError("read ETIMEDOUT", Code.Unavailable)),
        );
        const server = yield* fake();
        const destroyed = yield* fake(
          failing(
            new ConnectError(
              "lost the connection to the machine during exec: the machine was destroyed",
              Code.Unavailable,
            ),
          ),
        );
        const cases = [
          { url: server.url, credential: "other", machine: MACHINE, says: "UNAUTHENTICATED" },
          { url: unavailable.url, credential: KEY, machine: MACHINE, says: "UNAVAILABLE" },
          { url: "http://127.0.0.1:1", credential: KEY, machine: MACHINE, says: "UNAVAILABLE" },
          { url: server.url, credential: KEY, machine: MachineId.make("vm-gone"), says: "is gone" },
          { url: destroyed.url, credential: KEY, machine: MACHINE, says: "is gone" },
        ];
        for (const { url, credential, machine, says } of cases) {
          const failure = yield* Effect.gen(function* () {
            const exec = yield* BoxdExec;
            const transport = boxdTransport(exec, machine);
            const process = yield* transport.run("true", Stream.empty);
            yield* Stream.runDrain(Stream.merge(process.stdout, process.stderr));
            return yield* process.exitCode;
          }).pipe(
            Effect.scoped,
            Effect.provide(boxdExecLayer(url, bearer(credential))),
            Effect.flip,
          );
          assert(Schema.is(HostUnreachable)(failure), says);
          assert.strictEqual(failure.destination, machine);
          assert.include(failure.message, says);
          if (says !== "is gone") assert.notInclude(failure.message, "is gone");
          assert.notInclude(failure.message, KEY);
        }
      }).pipe(Effect.scoped),
  );

  it.live("fails when the stream ends without an exit code", () =>
    Effect.gen(function* () {
      const server = yield* fake(replies({ data: "partial" }));
      const failure = yield* run(server.url, "true").pipe(Effect.flip);

      assert.strictEqual(failure.code, "UNAVAILABLE");
      assert.strictEqual(failure.message, "boxd ended the exec stream without an exit code");
    }).pipe(Effect.scoped),
  );

  it.live("takes the exit code from the last response only", () =>
    Effect.gen(function* () {
      const early = yield* fake(replies({ data: "a" }, { exitCode: 0 }, { data: "b" }));
      const failure = yield* run(early.url, "true").pipe(Effect.flip);
      assert.strictEqual(failure.message, "boxd ended the exec stream without an exit code");

      const combined = yield* fake(replies({ data: "a" }, { data: "b", exitCode: 3 }));
      const result = yield* run(combined.url, "true");
      assert.strictEqual(decoder.decode(result.stdout), "ab");
      assert.strictEqual(result.exitCode, 3);
    }).pipe(Effect.scoped),
  );

  it.live("reads the bearer at the start of each call and ends a call whose bearer fails", () =>
    Effect.gen(function* () {
      const server = yield* fake();
      const refusal = BoxdCallError.make({
        operation: "authenticate",
        url: "https://app.boxd.test/api/v1/auth/token",
        code: "UNAUTHENTICATED",
        message: "Token exchange returned HTTP 401",
      });
      const bearers = [bearer("stale"), bearer(KEY), Effect.fail(refusal)];
      let reads = 0;
      const credential = Effect.suspend(() => bearers[reads++] ?? Effect.die("no more bearers"));
      const exitCodes = yield* Effect.gen(function* () {
        const exec = yield* BoxdExec;
        return yield* Effect.forEach([1, 2, 3], () =>
          Effect.gen(function* () {
            const execution = yield* exec.exec(MACHINE, "true", Stream.empty);
            yield* Stream.runDrain(Stream.merge(execution.stdout, execution.stderr));
            return yield* Effect.result(execution.exitCode);
          }).pipe(Effect.scoped),
        );
      }).pipe(Effect.provide(boxdExecLayer(server.url, credential)));

      assert.strictEqual(reads, 3);
      const [stale, accepted, failed] = exitCodes;
      assert(stale !== undefined && Result.isFailure(stale));
      assert(stale.failure._tag === "BoxdCallError");
      assert.strictEqual(stale.failure.code, "UNAUTHENTICATED");
      assert.deepStrictEqual(accepted, Result.succeed(0));
      assert(failed !== undefined && Result.isFailure(failed));
      assert.strictEqual(failed.failure, refusal);
      assert.deepStrictEqual(
        server.calls.map(({ authorization }) => authorization),
        [`Bearer ${KEY}`],
      );
    }).pipe(Effect.scoped),
  );

  it.live("cancels the call through its abort signal when its scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>();
      const server = yield* fake((call) =>
        Stream.fromEffect(Deferred.succeed(started, call.signal)).pipe(
          Stream.flatMap(() => Stream.never),
        ),
      );
      const services = yield* Layer.build(boxdExecLayer(server.url, bearer(KEY)));
      const exec = Context.get(services, BoxdExec);
      const fiber = yield* Effect.gen(function* () {
        const execution = yield* exec.exec(MACHINE, "sleep 600", Stream.empty);
        return yield* execution.exitCode;
      }).pipe(Effect.scoped, Effect.forkChild);
      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Effect.sleep("200 millis");

      assert.isTrue(signal.aborted);
      assert.isAbove(server.sessions.size, 0);
      for (const session of server.sessions) assert.isFalse(session.closed || session.destroyed);
    }).pipe(Effect.scoped),
  );

  it.live(
    "runs every call of one layer over one HTTP/2 connection, and reconnects after it closes",
    () =>
      Effect.gen(function* () {
        const server = yield* fake();
        const services = yield* Layer.build(boxdExecLayer(server.url, bearer(KEY)));
        const exec = Context.get(services, BoxdExec);
        const exitCodeOf = (command: string) =>
          Effect.gen(function* () {
            const execution = yield* exec.exec(MACHINE, command, Stream.empty);
            yield* Stream.runDrain(Stream.merge(execution.stdout, execution.stderr));
            return yield* execution.exitCode;
          }).pipe(Effect.scoped);

        const sequential = yield* Effect.all([
          exitCodeOf("true"),
          exitCodeOf("true"),
          exitCodeOf("true"),
        ]);
        assert.deepStrictEqual(sequential, [0, 0, 0]);
        const concurrent = yield* Effect.all([exitCodeOf("exit 3"), exitCodeOf("exit 4")], {
          concurrency: "unbounded",
        });
        assert.deepStrictEqual(concurrent, [3, 4]);
        assert.lengthOf(server.calls, 5);
        assert.strictEqual(server.sessions.size, 1);

        for (const session of server.sessions) session.destroy();
        yield* Effect.sleep("100 millis");
        const reconnected = yield* exitCodeOf("exit 5");
        assert.strictEqual(reconnected, 5);
        assert.lengthOf(server.calls, 6);
        assert.strictEqual(server.sessions.size, 2);
      }).pipe(Effect.scoped),
  );

  it.live("fails the exit code of a call whose scope closes before the command exits", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const server = yield* fake(() =>
        Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
          Stream.flatMap(() => Stream.never),
        ),
      );
      const services = yield* Layer.build(boxdExecLayer(server.url, bearer(KEY)));
      const exec = Context.get(services, BoxdExec);
      const scope = yield* Scope.make();
      const execution = yield* exec
        .exec(MACHINE, "sleep 600", Stream.empty)
        .pipe(Scope.provide(scope));
      const awaiter = yield* Effect.forkChild(Effect.flip(execution.exitCode));
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      const failure = yield* Fiber.join(awaiter).pipe(Effect.timeout("2 seconds"));

      assert(failure._tag === "BoxdCallError");
      assert.strictEqual(failure.code, "CANCELLED");
      assert.strictEqual(failure.message, "the call's scope closed before the command exited");
      yield* Stream.runDrain(Stream.merge(execution.stdout, execution.stderr)).pipe(
        Effect.timeout("2 seconds"),
      );
    }).pipe(Effect.scoped),
  );

  it("fails a dead connection within a minute by default", () => {
    assert.isAtMost(DEFAULT_KEEPALIVE.pingInterval + DEFAULT_KEEPALIVE.pingTimeout, 60_000);
  });

  it.live("fails a silent command within the keepalive bound when the connection dies", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const server = yield* fake(() =>
        Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
          Stream.flatMap(() => Stream.never),
        ),
      );
      const proxy = yield* blackHoleProxy(new URL(server.url).port);
      const fiber = yield* Effect.gen(function* () {
        const exec = yield* BoxdExec;
        const execution = yield* exec.exec(MACHINE, "sleep 2400", Stream.never);
        return yield* execution.exitCode;
      }).pipe(
        Effect.scoped,
        Effect.provide(
          boxdExecLayer(proxy.url, bearer(KEY), { pingInterval: 100, pingTimeout: 200 }),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      proxy.drop();
      const failure = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"));

      assert(failure._tag === "BoxdCallError");
      assert.strictEqual(failure.code, "UNAVAILABLE");
    }).pipe(Effect.scoped),
  );
});

/**
 * Starts a TCP proxy to `port` on the loopback interface. After `drop`, it discards every byte in
 * both directions without closing a socket, as a dead network path does.
 */
const blackHoleProxy = (port: string) =>
  Effect.gen(function* () {
    let dropped = false;
    const sockets = new Set<Socket>();
    const relay = (from: Socket, to: Socket) =>
      from.on("data", (bytes: Buffer) => {
        if (!dropped) to.write(bytes);
      });
    const server = createServer((client) => {
      const upstream = connect(Number(port), "127.0.0.1");
      sockets.add(client).add(upstream);
      relay(client, upstream);
      relay(upstream, client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      }),
      () =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resume(Effect.void));
        }),
    );
    const address = server.address();
    if (address === null || Predicate.isString(address))
      return yield* Effect.die(new Error("the proxy has no port"));
    return {
      url: `http://127.0.0.1:${address.port}`,
      drop: () => {
        dropped = true;
      },
    };
  });
