import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { Effect, Predicate, Ref, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { createServer, type Http2Session } from "node:http2";
import { runLocally as runCommand } from "../../remote/local-command.ts";
import {
  BoxdApi as BoxdService,
  type ExecChunk,
} from "../../../src/ssh/provisioner/boxd/api-pb.ts";
import { BoxdCallError } from "../../../src/ssh/provisioner/boxd/client.ts";
import { BoxdExec } from "../../../src/ssh/provisioner/boxd/exec.ts";
import { BOXD_ENDPOINT } from "./fake-boxd.ts";

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

/**
 * Returns a `BoxdExec` that runs each command line through `spawner` as
 * `boxd-exec <machine> -- <line>`, which `fakeMachine` answers as it answers an SSH command to the
 * machine, and reports its exit code 255 as a call that boxd ended with `UNAVAILABLE`.
 */
export const spawnedBoxdExec = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  BoxdExec.of({
    exec: (machine, command, stdin) =>
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(ChildProcess.make("boxd-exec", [machine, "--", command], { stdin }))
          .pipe(Effect.orDie);
        const stderr = yield* Ref.make("");
        return {
          stdout: handle.stdout.pipe(Stream.orDie),
          stderr: handle.stderr.pipe(
            Stream.orDie,
            Stream.tap((bytes) =>
              Ref.update(stderr, (text) => text + new TextDecoder().decode(bytes)),
            ),
          ),
          exitCode: handle.exitCode.pipe(
            Effect.orDie,
            Effect.flatMap((code) =>
              code === 255
                ? Ref.get(stderr).pipe(
                    Effect.flatMap((message) =>
                      Effect.fail(
                        BoxdCallError.make({
                          operation: "exec",
                          url: BOXD_ENDPOINT,
                          code: "UNAVAILABLE",
                          message,
                        }),
                      ),
                    ),
                  )
                : Effect.succeed(Number(code)),
            ),
          ),
        };
      }),
  });
