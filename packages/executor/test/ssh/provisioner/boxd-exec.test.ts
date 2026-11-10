import { Code, ConnectError } from "@connectrpc/connect";
import { assert, describe, it } from "@effect/vitest";
import { MachineId } from "@usine/core/worker";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Predicate,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { connect, createServer, type Socket } from "node:net";
import {
  BoxdExec,
  boxdExecLayer,
  BoxdMachineGone,
  STDIN_CHUNK_BYTES,
} from "../../../src/ssh/provisioner/boxd/exec.ts";
import { type ExecHandler, fakeBoxdExec, runLocally } from "./fake-boxd-exec.ts";

const KEY = "bxd_exec_test_key";
const isGone = Schema.is(BoxdMachineGone);
const MACHINE = MachineId.make("vm-exec-1");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Runs `command` on the fake through a fresh `BoxdExec`, collecting both streams and the exit code. */
const run = (
  url: string,
  command: string,
  stdin: Stream.Stream<Uint8Array> = Stream.empty,
  options: { readonly machine?: MachineId; readonly credential?: string } = {},
) =>
  Effect.gen(function* () {
    const exec = yield* BoxdExec;
    const execution = yield* exec.exec(options.machine ?? MACHINE, command, stdin);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        execution.stdout.pipe(Stream.runCollect),
        execution.stderr.pipe(Stream.runCollect),
        execution.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    const join = (chunks: ReadonlyArray<Uint8Array>) => Buffer.concat(chunks);
    return { stdout: join(stdout), stderr: join(stderr), exitCode };
  }).pipe(
    Effect.scoped,
    Effect.provide(boxdExecLayer(url, Redacted.make(options.credential ?? KEY))),
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

  it.live("raises the HTTP/2 connection window to 8 MiB before it sends stdin", () =>
    Effect.gen(function* () {
      const windows: Array<number> = [];
      const server = yield* fakeBoxdExec({
        credential: KEY,
        machines: new Set([MACHINE]),
        handler: () =>
          Stream.sync(() => {
            for (const session of server.sessions)
              windows.push(session.state.remoteWindowSize ?? 0);
            return { exitCode: 0 };
          }),
      });
      yield* run(server.url, "true");

      assert.isAtLeast(Math.max(...windows), 8 * 1024 * 1024 - 1024);
    }).pipe(Effect.scoped),
  );

  it.live("maps each gRPC status to a typed error without the credential", () =>
    Effect.gen(function* () {
      const cases = [
        {
          error: new ConnectError("VM not found (region fra)", Code.NotFound),
          expected: "BoxdMachineGone",
        },
        {
          error: new ConnectError(
            "lost the connection to the machine during exec: the machine was destroyed",
            Code.Unavailable,
          ),
          expected: "BoxdMachineGone",
        },
        {
          error: new ConnectError("read ETIMEDOUT", Code.Unavailable),
          expected: "UNAVAILABLE",
        },
        {
          error: new ConnectError(`bad key ${KEY}`, Code.PermissionDenied),
          expected: "PERMISSION_DENIED",
        },
      ];
      for (const { error, expected } of cases) {
        const server = yield* fake(failing(error));
        const failure = yield* run(server.url, "true").pipe(Effect.flip);
        if (expected === "BoxdMachineGone") {
          assert.isTrue(isGone(failure), error.rawMessage);
        } else {
          assert(failure._tag === "BoxdCallError");
          assert.strictEqual(failure.code, expected);
          assert.notInclude(failure.message, KEY);
        }
      }
      const server = yield* fake();
      const refused = yield* run(server.url, "true", Stream.empty, { credential: "other" }).pipe(
        Effect.flip,
      );
      assert(refused._tag === "BoxdCallError");
      assert.strictEqual(refused.code, "UNAUTHENTICATED");
      const unknown = yield* run(server.url, "true", Stream.empty, {
        machine: MachineId.make("vm-unknown"),
      }).pipe(Effect.flip);
      assert.isTrue(isGone(unknown));
    }).pipe(Effect.scoped),
  );

  it.live("fails when the stream ends without an exit code", () =>
    Effect.gen(function* () {
      const server = yield* fake(replies({ data: "partial" }));
      const failure = yield* run(server.url, "true").pipe(Effect.flip);

      assert(failure._tag === "BoxdCallError");
      assert.strictEqual(failure.code, "UNAVAILABLE");
    }).pipe(Effect.scoped),
  );

  it.live("cancels the call when its scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal>();
      const server = yield* fake((call) =>
        Stream.fromEffect(Deferred.succeed(started, call.signal)).pipe(
          Stream.flatMap(() => Stream.never),
        ),
      );
      const services = yield* Layer.build(boxdExecLayer(server.url, Redacted.make(KEY)));
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
          boxdExecLayer(proxy.url, Redacted.make(KEY), { pingInterval: 100, pingTimeout: 200 }),
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
