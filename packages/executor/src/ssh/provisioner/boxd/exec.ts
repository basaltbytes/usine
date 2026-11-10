import { ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { type ExecTransport, HostUnreachable } from "@usine/agents/child-host";
import { MachineId } from "@usine/core/worker";
import {
  type Brand,
  type Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Redacted,
  Schema,
  type Scope,
  Stream,
} from "effect";
import type { ClientHttp2Stream } from "node:http2";
import { BoxdApi as BoxdService, type ExecChunk } from "./api-pb.ts";
import { BoxdCallError } from "./client.ts";
import { failureCode } from "./status.ts";

/** The error when the machine of an `Exec` call doesn't exist, or boxd deleted it during the call. */
export class BoxdMachineGone extends Schema.TaggedError<
  BoxdMachineGone,
  Brand.Brand<"@usine/executor/boxd/BoxdMachineGone">
>()("BoxdMachineGone", {
  machine: MachineId,
  message: Schema.String,
}) {}

/**
 * Why an `Exec` call ended without an exit code: `BoxdMachineGone`, or a `BoxdCallError` with the
 * gRPC status, such as `UNAVAILABLE` for an unreachable endpoint or a dropped connection.
 */
export type BoxdExecError = BoxdCallError | BoxdMachineGone;

/**
 * A command that runs on a boxd machine. Read `stdout` and `stderr` at the same time: each holds a
 * few chunks, and the call stops reading from boxd while either is full, as a pipe does. Both end
 * when the call ends, after every chunk boxd sent, so read them to their end before you await a
 * failed `exitCode`.
 */
export interface BoxdExecution {
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr: Stream.Stream<Uint8Array>;
  /**
   * The command's exit code once the call ends: 128 plus the signal number for a command that a
   * signal ended. Fails if the call ends without one, including when its scope closes first.
   */
  readonly exitCode: Effect.Effect<number, BoxdExecError>;
}

/** Runs commands on boxd machines over boxd's gRPC `Exec` stream. */
export class BoxdExec extends Context.Service<
  BoxdExec,
  {
    /**
     * Runs `command` on `machine` as boxd's `/bin/sh -c` command line, in its own process group,
     * and writes `stdin` to the command's stdin until the stream ends, which closes it. The call
     * ends when the command's leader process exits, so output that a background process writes
     * later is lost. Closing the scope before then cancels the call, and boxd sends `TERM` to the
     * command's process group, then `KILL` about 3 seconds later.
     */
    readonly exec: (
      machine: MachineId,
      command: string,
      stdin: Stream.Stream<Uint8Array>,
    ) => Effect.Effect<BoxdExecution, never, Scope.Scope>;
  }
>()("@usine/executor/ssh/provisioner/boxd/exec/BoxdExec") {}

/**
 * The receive window of the HTTP/2 connection and of each stream. At the default 64 KiB, output
 * runs at 1.3 MB/s per stream; at 8 MiB, at 30 to 60 MB/s (docs/research/boxd-exec-transport.md).
 */
const RECEIVE_WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * The most stdin bytes in one `ExecChunk`. boxd closes the command's stdin at a chunk of 4 MiB or
 * more without an error, and the command exits 0.
 */
export const STDIN_CHUNK_BYTES = 64 * 1024;

/** The chunks that each output stream holds before the call stops reading from boxd. */
const OUTPUT_BUFFER_CHUNKS = 16;

/** The message of the `UNAVAILABLE` status that ends a call when boxd deletes its machine. */
const DESTROYED = "the machine was destroyed";

interface ExecTransportOptions {
  /**
   * The time without a received frame after which the client sends an HTTP/2 PING. A connection
   * with no traffic for 40 minutes was dropped without either end noticing, so a silent command
   * fails within this time plus `pingTimeout` instead of at the next write.
   */
  readonly pingInterval?: number;
  /** The time a PING has to be answered before the connection and its calls fail, in milliseconds. */
  readonly pingTimeout?: number;
}

/**
 * The connection's session manager. connect-node sets the stream window from the session settings,
 * but never raises the connection window, which limits every stream on the connection to 1.3 MB/s.
 * Each request raises it on the session that carries it; the size is absolute, so a repeat is a
 * no-op.
 */
class WindowedSessionManager extends Http2SessionManager {
  override request(
    ...args: Parameters<Http2SessionManager["request"]>
  ): Promise<ClientHttp2Stream> {
    return super.request(...args).then((stream) => {
      stream.session?.setLocalWindowSize(RECEIVE_WINDOW_BYTES);
      return stream;
    });
  }
}

type ExecRequest = Partial<Pick<ExecChunk, "vmId" | "command" | "data" | "stdin">>;

/** Splits `bytes` into views of at most `STDIN_CHUNK_BYTES`, without copying. */
const stdinPieces = (bytes: Uint8Array): Array<Uint8Array> =>
  Array.from({ length: Math.ceil(bytes.length / STDIN_CHUNK_BYTES) }, (_, index) =>
    bytes.subarray(index * STDIN_CHUNK_BYTES, (index + 1) * STDIN_CHUNK_BYTES),
  );

/**
 * Returns the `BoxdExec` that calls `endpoint`, a region's API endpoint URL, with `credential` as
 * the bearer. Each layer owns one HTTP/2 connection, opened at the first call and closed with the
 * layer.
 */
export const boxdExecLayer = (
  endpoint: string,
  credential: Redacted.Redacted<string>,
  options: ExecTransportOptions = {},
) =>
  Layer.effect(
    BoxdExec,
    Effect.gen(function* () {
      const sessionManager = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WindowedSessionManager(
              endpoint,
              {
                pingIntervalMs: options.pingInterval ?? 30_000,
                pingTimeoutMs: options.pingTimeout ?? 20_000,
              },
              { settings: { initialWindowSize: RECEIVE_WINDOW_BYTES } },
            ),
        ),
        (manager) => Effect.sync(() => manager.abort()),
      );
      const client = createClient(
        BoxdService,
        createGrpcTransport({ baseUrl: endpoint, sessionManager }),
      );
      const secret = Redacted.value(credential);

      const failureOf = (machine: MachineId, cause: unknown): BoxdExecError => {
        const failure = ConnectError.from(cause);
        const code = failureCode(failure);
        const message = failure.rawMessage.replaceAll(secret, "[redacted]");
        return code === "NOT_FOUND" || (code === "UNAVAILABLE" && message.includes(DESTROYED))
          ? BoxdMachineGone.make({ machine, message })
          : BoxdCallError.make({ operation: "exec", code, message });
      };

      const exec = Effect.fn("BoxdExec.exec")(function* (
        machine: MachineId,
        command: string,
        stdin: Stream.Stream<Uint8Array>,
      ) {
        yield* Effect.annotateCurrentSpan({ machine });
        const stdout = yield* Queue.bounded<Uint8Array, Cause.Done>(OUTPUT_BUFFER_CHUNKS);
        const stderr = yield* Queue.bounded<Uint8Array, Cause.Done>(OUTPUT_BUFFER_CHUNKS);
        const exitCode = yield* Deferred.make<number, BoxdExecError>();
        const settle = (result: Exit.Exit<number, BoxdExecError>) =>
          Effect.all([Queue.end(stdout), Queue.end(stderr), Deferred.done(exitCode, result)], {
            discard: true,
          });
        yield* Effect.addFinalizer(() =>
          settle(
            Exit.fail(
              BoxdCallError.make({
                operation: "exec",
                code: "CANCELLED",
                message: "the call's scope closed before the command exited",
              }),
            ),
          ),
        );
        const requests = Stream.concat(
          Stream.succeed<ExecRequest>({ vmId: machine, command }),
          stdin.pipe(
            Stream.flatMap((bytes) => Stream.fromIterable(stdinPieces(bytes))),
            Stream.map((data): ExecRequest => ({ data, stdin: true })),
          ),
        );
        const call = Effect.gen(function* () {
          const controller = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          // connect-node stops pulling the requests when the response ends, but never returns the
          // iterator, which would keep waiting for stdin.
          const iterator = yield* Effect.acquireRelease(
            Effect.sync(() => Stream.toAsyncIterable(requests)[Symbol.asyncIterator]()),
            (iterator) => Effect.promise(() => Promise.resolve(iterator.return?.())),
          );
          const responses = client.exec(
            { [Symbol.asyncIterator]: () => iterator },
            { signal: controller.signal, headers: { authorization: `Bearer ${secret}` } },
          );
          let exited: number | undefined;
          yield* Stream.fromAsyncIterable(responses, (cause) => failureOf(machine, cause)).pipe(
            Stream.runForEach((chunk) =>
              chunk.data.length === 0
                ? Effect.sync(() => {
                    exited = chunk.exitCode;
                  })
                : Queue.offer(chunk.isStderr ? stderr : stdout, chunk.data),
            ),
          );
          if (exited === undefined)
            return yield* BoxdCallError.make({
              operation: "exec",
              code: "UNAVAILABLE",
              message: "boxd ended the exec stream without an exit code",
            });
          return exited;
        }).pipe(Effect.scoped);
        yield* call.pipe(Effect.exit, Effect.flatMap(settle), Effect.forkScoped);
        return {
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.fromQueue(stderr),
          exitCode: Deferred.await(exitCode),
        } satisfies BoxdExecution;
      });
      return BoxdExec.of({ exec });
    }),
  );

/**
 * Returns the `ExecTransport` that runs command lines on boxd machine `machine` through `exec`. A
 * call that ends without an exit code fails with `HostUnreachable`, whose message says whether boxd
 * deleted the machine or which gRPC status ended the call.
 */
export const boxdTransport = (exec: BoxdExec["Service"], machine: MachineId): ExecTransport => ({
  run: (line, stdin) =>
    exec.exec(machine, line, stdin).pipe(
      Effect.map((execution) => ({
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode.pipe(
          Effect.tapError((error) =>
            Effect.logDebug("A boxd exec call ended without an exit code", {
              machine,
              error: error._tag,
              code: error._tag === "BoxdCallError" ? error.code : "NOT_FOUND",
            }),
          ),
          Effect.mapError((error) =>
            HostUnreachable.make({
              destination: machine,
              message:
                error._tag === "BoxdMachineGone"
                  ? `boxd machine ${machine} is gone: ${error.message}`
                  : `boxd exec on ${machine} failed: ${error.code}: ${error.message}`,
            }),
          ),
        ),
      })),
    ),
});
