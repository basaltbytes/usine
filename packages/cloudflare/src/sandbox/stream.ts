import { type Cause, Duration, Effect, Fiber, Option, Queue, Stream } from "effect";
import type { ProcessId, SandboxName } from "../api/api.ts";
import {
  type AttachOffsets,
  decodeClientMessage,
  encodeServerMessage,
  Exited,
  type OutputChannel,
  outputFrame,
  Started,
  StreamFailed,
} from "../api/stream.ts";
import { ContainerFailure, SandboxContainer } from "./ports.ts";
import { exitCodeOf, newProcessId, processCommand, processFiles } from "./process.ts";
import { extendLease, runningSandboxFor } from "./sandbox.ts";

/** A WebSocket that the Durable Object accepted. */
export interface StreamSocket {
  /** Sends a message. Does nothing once the socket is closed. */
  readonly send: (message: string | Uint8Array) => Effect.Effect<void>;
  readonly close: (code: number, reason: string) => Effect.Effect<void>;
  /** The client's messages. Ends when the client closes the socket. */
  readonly messages: Queue.Dequeue<string | Uint8Array, Cause.Done>;
}

/** The time a client has to send its first message. */
const START_TIMEOUT = Duration.seconds(30);
/** The interval at which an attach stream reads the process files again. */
const ATTACH_POLL = Duration.millis(500);
/** The maximum bytes in one binary message. */
const FRAME_BYTES = 64 * 1024;

const decoder = new TextDecoder();

/** Sends `message` as a stream failure and closes the socket. */
const refuse = (socket: StreamSocket, message: string) =>
  socket
    .send(encodeServerMessage(new StreamFailed({ message })))
    .pipe(Effect.andThen(socket.close(1011, "stream failed")));

/** Sends `bytes` of `channel` in messages of at most `FRAME_BYTES`. */
const sendOutput = (socket: StreamSocket, channel: OutputChannel, bytes: Uint8Array) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(bytes.length / FRAME_BYTES) }, (_, index) =>
      bytes.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES),
    ),
    (chunk) => socket.send(outputFrame(channel, chunk)),
    { discard: true },
  );

const pump = (
  socket: StreamSocket,
  channel: OutputChannel,
  stream: ReadableStream<Uint8Array> | null,
) =>
  stream === null
    ? Effect.void
    : Stream.fromReadableStream({
        evaluate: () => stream,
        onError: (cause) =>
          new ContainerFailure({
            operation: "exec",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }).pipe(Stream.runForEach((bytes) => sendOutput(socket, channel, bytes)));

/**
 * Writes the client's binary messages to `stdin`, and closes it on `StdinEnd` or when the client
 * closes the socket, as a dropped SSH connection closes a remote command's stdin.
 */
const feed = (socket: StreamSocket, stdin: WritableStream<Uint8Array> | null) =>
  Effect.gen(function* () {
    if (stdin === null) return;
    const writer = stdin.getWriter();
    const close = Effect.promise(() => writer.close().catch(() => undefined));
    yield* Stream.fromQueue(socket.messages).pipe(
      Stream.takeWhile((message) => {
        if (message instanceof Uint8Array) return true;
        return Option.match(decodeClientMessage(message), {
          onNone: () => true,
          onSome: (decoded) => decoded._tag !== "StdinEnd",
        });
      }),
      Stream.runForEach((message) =>
        message instanceof Uint8Array
          ? Effect.promise(() => writer.write(message).catch(() => undefined))
          : Effect.void,
      ),
      Effect.ensuring(close),
    );
  });

/**
 * Runs one command for the client on `socket`: the first message is `ExecStart`, then binary
 * messages are its stdin, and the sandbox sends `Started`, the output as binary messages, and
 * `Exited`. The command runs through `PROCESS_SCRIPT`, so it keeps running, and its output keeps
 * going to its process files, if the client disconnects.
 */
export const execStream = Effect.fn("Sandbox.execStream")(function* (
  name: SandboxName,
  socket: StreamSocket,
) {
  yield* Effect.annotateCurrentSpan({ sandbox: name });
  const first = yield* Queue.take(socket.messages).pipe(
    Effect.timeoutOption(START_TIMEOUT),
    Effect.catchTag("Done", () => Effect.succeedNone),
  );
  const start = Option.flatMap(first, (message) =>
    message instanceof Uint8Array
      ? Option.none()
      : Option.filter(decodeClientMessage(message), (decoded) => decoded._tag === "ExecStart"),
  );
  if (Option.isNone(start) || start.value._tag !== "ExecStart") {
    yield* Effect.logWarning("Refused an exec stream that didn't start a command", {
      sandbox: name,
    });
    return yield* refuse(socket, "The first message must be ExecStart");
  }
  const command = start.value.command;
  const sandbox = yield* runningSandboxFor(name).pipe(Effect.option);
  if (Option.isNone(sandbox)) {
    yield* Effect.logWarning("Refused a command for a sandbox without a running container", {
      sandbox: name,
    });
    return yield* refuse(socket, `Sandbox ${name} doesn't exist or its container isn't running`);
  }
  yield* extendLease(sandbox.value);
  const container = yield* SandboxContainer;
  const process = newProcessId();
  const fields = { sandbox: name, attempt: sandbox.value.attempt, process };
  const started = yield* container
    .exec(processCommand(process, command), "pipe")
    .pipe(Effect.option);
  if (Option.isNone(started)) {
    yield* Effect.logError("The container didn't start a command", fields);
    return yield* refuse(socket, "The container didn't start the command");
  }
  const handle = started.value;
  yield* socket.send(encodeServerMessage(new Started({ process })));
  yield* Effect.logInfo("Started a command in the sandbox", {
    ...fields,
    commandBytes: command.length,
  });
  const input = yield* Effect.forkChild(feed(socket, handle.stdin));
  const output = yield* Effect.all(
    [pump(socket, "stdout", handle.stdout), pump(socket, "stderr", handle.stderr)],
    { concurrency: 2, discard: true },
  ).pipe(Effect.forkChild);
  const exitCode = yield* Effect.tryPromise({
    try: () => handle.exitCode,
    catch: (cause) =>
      new ContainerFailure({
        operation: "exec",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(Effect.option);
  yield* Fiber.join(output).pipe(Effect.ignore);
  yield* Fiber.interrupt(input);
  if (Option.isNone(exitCode)) {
    yield* Effect.logError("Lost the command's exit code", fields);
    return yield* refuse(socket, "The container lost the command's exit code");
  }
  yield* socket.send(encodeServerMessage(new Exited({ exitCode: exitCode.value })));
  yield* socket.close(1000, "exited");
  yield* Effect.logInfo("The sandbox's command exited", { ...fields, exitCode: exitCode.value });
});

/**
 * Streams a command's output from its process files, after the bytes in `offsets`, then its exit
 * code, for a client whose exec stream was cut. Nothing reaches the command's stdin.
 */
export const attachStream = Effect.fn("Sandbox.attachStream")(function* (
  name: SandboxName,
  process: ProcessId,
  offsets: AttachOffsets,
  socket: StreamSocket,
) {
  const fields = { sandbox: name, process };
  yield* Effect.annotateCurrentSpan(fields);
  const sandbox = yield* runningSandboxFor(name).pipe(Effect.option);
  if (Option.isNone(sandbox)) return yield* refuse(socket, `Sandbox ${name} isn't running`);
  const container = yield* SandboxContainer;
  const files = processFiles(process);
  const known = yield* container.read(files.pid).pipe(Effect.option);
  if (Option.isNone(Option.flatten(known))) {
    yield* Effect.logWarning("Refused to attach to an unknown command", fields);
    return yield* refuse(socket, `Sandbox ${name} has no command ${process}`);
  }
  yield* extendLease(sandbox.value);
  yield* Effect.logInfo("Attached to a command's output", { ...fields, ...offsets });
  let sent = { stdout: offsets.stdout, stderr: offsets.stderr };
  const forward = (channel: OutputChannel) =>
    container.readFrom(files[channel], sent[channel]).pipe(
      Effect.flatMap((bytes) => {
        const read = Option.getOrElse(bytes, () => new Uint8Array());
        sent = { ...sent, [channel]: sent[channel] + read.length };
        return sendOutput(socket, channel, read);
      }),
    );
  const follow = Effect.gen(function* () {
    while (true) {
      // Reads the exit file first, so the output read after it is complete when it exists.
      const exit = Option.flatMap(yield* container.read(files.exit), (bytes) =>
        exitCodeOf(decoder.decode(bytes)),
      );
      yield* forward("stdout");
      yield* forward("stderr");
      if (Option.isSome(exit)) return exit.value;
      yield* Effect.sleep(ATTACH_POLL);
    }
  });
  const disconnected = Stream.fromQueue(socket.messages).pipe(Stream.runDrain);
  const outcome = yield* Effect.raceFirst(
    follow.pipe(Effect.map(Option.some)),
    disconnected.pipe(Effect.as(Option.none<number>())),
  ).pipe(Effect.option);
  const exitCode = Option.flatten(outcome);
  if (Option.isNone(outcome)) {
    yield* Effect.logError("Could not read the command's process files", fields);
    return yield* refuse(socket, "The container failed to read the command's process files");
  }
  if (Option.isNone(exitCode)) {
    yield* Effect.logInfo("The client left the attach stream", fields);
    return;
  }
  yield* socket.send(encodeServerMessage(new Exited({ exitCode: exitCode.value })));
  yield* socket.close(1000, "exited");
  yield* Effect.logInfo("The attached command exited", { ...fields, exitCode: exitCode.value });
});
