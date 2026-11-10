import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { Effect, Predicate, Stream } from "effect";
import { createServer, type Http2Session } from "node:http2";
import { runLocally as runCommand } from "../../remote/local-command.ts";
import {
  BoxdApi as BoxdService,
  type ExecChunk,
} from "../../../src/ssh/provisioner/boxd/api-pb.ts";

type ExecReply = Partial<Pick<ExecChunk, "data" | "isStderr" | "exitCode">>;

/** One `Exec` call that the fake received. */
export interface ExecCall {
  readonly machine: string;
  readonly command: string;
  readonly authorization: string | null;
  readonly signal: AbortSignal;
  /** The size of each stdin chunk, in order. */
  readonly stdinChunks: Array<number>;
}

/** Runs one call's command: its stdin until the client closes it, and the replies to send. */
export type ExecHandler = (
  call: ExecCall,
  stdin: Stream.Stream<Uint8Array>,
) => Stream.Stream<ExecReply>;

/** The stdin chunk size at which boxd closes the command's stdin without an error. */
const STDIN_LIMIT = 4 * 1024 * 1024;
/** The most output bytes boxd sends in one chunk. */
const OUTPUT_CHUNK = 4096;

const outputChunks = (data: Uint8Array, isStderr: boolean): Array<ExecReply> =>
  Array.from({ length: Math.ceil(data.length / OUTPUT_CHUNK) }, (_, index) => ({
    data: data.subarray(index * OUTPUT_CHUNK, (index + 1) * OUTPUT_CHUNK),
    isStderr,
  }));

/** Runs the call's command line with the local `sh -c`, as boxd's agent runs it. */
export const runLocally: ExecHandler = (call, stdin) =>
  runCommand(call.command, stdin, call.signal).pipe(
    Stream.flatMap((event) =>
      Stream.fromIterable(
        event._tag === "Exited"
          ? [{ exitCode: event.exitCode }]
          : outputChunks(event.bytes, event.channel === "stderr"),
      ),
    ),
  );

/**
 * Starts a fake boxd `Exec` endpoint on a local port, closed with the scope. It refuses a bearer
 * other than `credential` with `UNAUTHENTICATED`, answers `NOT_FOUND` for a machine not in
 * `machines`, and, as boxd does, closes a command's stdin at a chunk of 4 MiB or more.
 */
export const fakeBoxdExec = (options: {
  readonly credential: string;
  readonly machines: ReadonlySet<string>;
  readonly handler?: ExecHandler;
}) =>
  Effect.gen(function* () {
    const calls: Array<ExecCall> = [];
    const sessions = new Set<Http2Session>();
    const handler = options.handler ?? runLocally;
    const server = createServer(
      connectNodeAdapter({
        routes: (router) =>
          router.service(BoxdService, {
            exec: (requests, context) => {
              const iterator = requests[Symbol.asyncIterator]();
              const replies = Effect.gen(function* () {
                const first = yield* Effect.promise(() => iterator.next());
                if (first.done === true) return Stream.empty;
                const authorization = context.requestHeader.get("authorization");
                if (authorization !== `Bearer ${options.credential}`)
                  return yield* Effect.die(
                    new ConnectError(
                      "API key not recognized: it was deleted, or it is not a key of this cluster",
                      Code.Unauthenticated,
                    ),
                  );
                if (!options.machines.has(first.value.vmId))
                  return yield* Effect.die(
                    new ConnectError("VM not found (region fra)", Code.NotFound),
                  );
                const call: ExecCall = {
                  machine: first.value.vmId,
                  command: first.value.command,
                  authorization,
                  signal: context.signal,
                  stdinChunks: [],
                };
                calls.push(call);
                const stdin = Stream.fromAsyncIterable(
                  { [Symbol.asyncIterator]: () => iterator },
                  (cause) => cause,
                ).pipe(
                  Stream.tap((chunk) =>
                    Effect.sync(() => call.stdinChunks.push(chunk.data.length)),
                  ),
                  Stream.takeWhile((chunk) => chunk.data.length < STDIN_LIMIT),
                  Stream.map((chunk) => chunk.data),
                  Stream.orDie,
                );
                return handler(call, stdin);
              });
              return Stream.toAsyncIterable(Stream.unwrap(replies));
            },
          }),
      }),
    );
    server.on("session", (session) => sessions.add(session));
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.once("error", (cause) => resume(Effect.die(cause)));
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      }),
      () =>
        Effect.callback<void>((resume) => {
          for (const session of sessions) session.destroy();
          server.close(() => resume(Effect.void));
        }),
    );
    const address = server.address();
    if (address === null || Predicate.isString(address))
      return yield* Effect.die(new Error("the fake boxd server has no port"));
    return { url: `http://127.0.0.1:${address.port}`, calls, sessions };
  });
