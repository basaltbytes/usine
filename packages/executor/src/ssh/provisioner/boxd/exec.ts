import { ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { type ExecTransport, HostUnreachable } from "@usine/agents/child-host";
import { MachineId } from "@usine/core/worker";
import {
  type Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Queue,
  Redacted,
  type Scope,
  Stream,
} from "effect";
import type { ClientHttp2Stream } from "node:http2";
import { BoxdApi as BoxdService, type ExecChunk } from "./api-pb.ts";
import { BoxdCallError } from "./client.ts";
import { failureCode } from "./status.ts";

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
   * signal ended. Fails with the gRPC status if the call ends without one, such as `NOT_FOUND`
   * for an unknown machine, `UNAVAILABLE` for an unreachable endpoint, a dropped connection, or a
   * machine that boxd deleted during the call, and `CANCELLED` when the call's scope closes first.
   */
  readonly exitCode: Effect.Effect<number, BoxdCallError>;
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

/** The receive window of the HTTP/2 connection and of each stream. */
const RECEIVE_WINDOW_BYTES = 8 * 1024 * 1024;

/** The most stdin bytes in one `ExecChunk`. boxd closes the command's stdin at a chunk of 4 MiB. */
export const STDIN_CHUNK_BYTES = 64 * 1024;

/** The chunks that each output stream holds before the call stops reading from boxd. */
const OUTPUT_BUFFER_CHUNKS = 16;

/** The message of the `UNAVAILABLE` status that ends a call when boxd deletes its machine. */
const DESTROYED = "the machine was destroyed";

/** The keepalive of an `Exec` connection, in milliseconds. */
export interface ExecKeepalive {
  /** The time without a received frame after which the client sends an HTTP/2 PING. */
  readonly pingInterval: number;
  /** The time a PING has to be answered before the connection and its calls fail. */
  readonly pingTimeout: number;
}

/** The keepalive of a `boxdExecLayer` without options: a dead connection fails within 50 seconds. */
const DEFAULT_KEEPALIVE: ExecKeepalive = { pingInterval: 30_000, pingTimeout: 20_000 };

/**
 * The connection's session manager, which raises the connection's receive window on the session
 * of each request. The size is absolute, so a repeat is a no-op.
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
 * Returns `message` with each occurrence of `secret` replaced, or `message` itself for an empty
 * `secret`.
 */
const redact = (message: string, secret: string): string =>
  secret === "" ? message : message.replaceAll(secret, "[redacted]");

/**
 * Returns the `BoxdExec` that calls `endpoint`, a region's API endpoint URL, with the bearer that
 * `credential` returns at the start of each call. A call whose `credential` fails ends with that
 * error. Each layer owns one HTTP/2 connection, opened at the first call and closed with the layer.
 */
export const boxdExecLayer = (
  endpoint: string,
  credential: Effect.Effect<Redacted.Redacted<string>, BoxdCallError>,
  keepalive: ExecKeepalive = DEFAULT_KEEPALIVE,
) =>
  Layer.effect(
    BoxdExec,
    Effect.gen(function* () {
      const sessionManager = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WindowedSessionManager(
              endpoint,
              { pingIntervalMs: keepalive.pingInterval, pingTimeoutMs: keepalive.pingTimeout },
              { settings: { initialWindowSize: RECEIVE_WINDOW_BYTES } },
            ),
        ),
        (manager) => Effect.sync(() => manager.abort()),
      );
      const client = createClient(
        BoxdService,
        createGrpcTransport({ baseUrl: endpoint, sessionManager }),
      );

      const failureOf = (secret: string, cause: unknown) => {
        const failure = ConnectError.from(cause);
        return BoxdCallError.make({
          operation: "exec",
          url: endpoint,
          code: failureCode(failure),
          message: redact(failure.rawMessage, secret),
        });
      };

      const exec = Effect.fn("BoxdExec.exec")(function* (
        machine: MachineId,
        command: string,
        stdin: Stream.Stream<Uint8Array>,
      ) {
        yield* Effect.annotateCurrentSpan({ machine });
        const stdout = yield* Queue.bounded<Uint8Array, Cause.Done>(OUTPUT_BUFFER_CHUNKS);
        const stderr = yield* Queue.bounded<Uint8Array, Cause.Done>(OUTPUT_BUFFER_CHUNKS);
        const exitCode = yield* Deferred.make<number, BoxdCallError>();
        const settle = (result: Exit.Exit<number, BoxdCallError>) =>
          Effect.all([Queue.end(stdout), Queue.end(stderr), Deferred.done(exitCode, result)], {
            discard: true,
          });
        yield* Effect.addFinalizer(() =>
          settle(
            Exit.fail(
              BoxdCallError.make({
                operation: "exec",
                url: endpoint,
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
          const bearer = yield* credential;
          const secret = Redacted.value(bearer);
          // Aborting the signal cancels a call whose scope closes before the response ends.
          const controller = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );
          // connect-node returns the requests' iterator when the call ends, through a second
          // `[Symbol.asyncIterator]()` call, so the iterable answers the one iterator it sends.
          const iterator = Stream.toAsyncIterable(requests)[Symbol.asyncIterator]();
          const responses = client.exec(
            { [Symbol.asyncIterator]: () => iterator },
            { signal: controller.signal, headers: { authorization: `Bearer ${secret}` } },
          );
          // Only the last response ends the command: one without data, or one with a non-zero exit
          // code.
          let exited: number | undefined;
          yield* Stream.fromAsyncIterable(responses, (cause) => failureOf(secret, cause)).pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                exited =
                  chunk.data.length === 0 || chunk.exitCode !== 0 ? chunk.exitCode : undefined;
                if (chunk.data.length > 0)
                  yield* Queue.offer(chunk.isStderr ? stderr : stdout, chunk.data);
              }),
            ),
          );
          if (exited === undefined)
            return yield* BoxdCallError.make({
              operation: "exec",
              url: endpoint,
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

/** Whether `error` ended a call because its machine doesn't exist or boxd deleted it. */
const machineGone = (error: BoxdCallError): boolean =>
  error.code === "NOT_FOUND" || (error.code === "UNAVAILABLE" && error.message.includes(DESTROYED));

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
              code: error.code,
            }),
          ),
          Effect.mapError((error) =>
            HostUnreachable.make({
              destination: machine,
              message: machineGone(error)
                ? `boxd machine ${machine} is gone: ${error.message}`
                : `boxd exec on ${machine} failed: ${error.code}: ${error.message}`,
            }),
          ),
        ),
      })),
    ),
});
