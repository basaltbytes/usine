import type { AgentSessionId } from "@usine/core/agent/session";
import {
  type Brand,
  type Cause,
  Deferred,
  Effect,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { boundedLines, MAX_PROTOCOL_LINE_BYTES, previewLine } from "../../../child-host/lines.ts";
import type { ProcessCommand } from "../../../child-host/process.ts";
import { pendingRequests } from "../../../child-host/requests.ts";
import { type SessionOperation, SessionOperationError } from "../../../runtime.ts";
import { OPENCODE_BRIDGE } from "./bundle.js";
import {
  type BridgeAnswer,
  BridgeEvent,
  BridgeOutput,
  BridgeReady,
  BridgeInput,
  BridgeMcpClosed,
  BridgeMcpMessage,
  BridgeRequestFailed,
  type BridgeRequestId,
  type McpMessage,
  type OpenCodeEvent,
  type OpenCodeMethod,
  type OpenCodePath,
} from "./lines.ts";

const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeOutput));
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(BridgeInput));
const encoder = new TextEncoder();

/** Milliseconds that the bridge waits for OpenCode's first event once `serve` reports its address. */
const READY_WAIT_MS = 30_000;

/**
 * Returns the command that runs the bridge in `opencode.cwd` around `opencode`, the OpenCode
 * command with any leading arguments. The bridge adds `serve` and its options, runs with the
 * worker's `node`, and fails when OpenCode sends no event within 30 seconds of its address.
 */
export const bridgeCommand = (opencode: ProcessCommand): ProcessCommand => ({
  command: "node",
  args: ["-e", OPENCODE_BRIDGE, String(READY_WAIT_MS), opencode.command, ...opencode.args],
  cwd: opencode.cwd,
});

/** A message of a client MCP server that is longer than the bridge reads in a line. */
export class BridgeLineTooLong extends Schema.TaggedError<
  BridgeLineTooLong,
  Brand.Brand<"@usine/agents/BridgeLineTooLong">
>("@usine/agents/BridgeLineTooLong")("BridgeLineTooLong", {
  server: Schema.String,
  /** The bytes of the line, without its newline. */
  bytes: Schema.Int,
  message: Schema.NonEmptyString,
}) {}

/** A request to the OpenCode server, with `body` sent as JSON. */
interface OpenCodeRequest {
  readonly method: OpenCodeMethod;
  readonly path: OpenCodePath;
  readonly body?: Schema.Json;
}

/** The standard streams of a running bridge, such as a child process handle's. */
export interface BridgeStreams {
  /** `None` before a child session exists, such as during preflight. */
  readonly sessionId: Option.Option<AgentSessionId>;
  /** The bridge's standard input. The client writes request lines to it and ends it on `close`. */
  readonly input: Queue.Queue<Uint8Array, Cause.Done>;
  /** The bridge's standard output. */
  readonly output: Stream.Stream<Uint8Array, SessionOperationError>;
  /**
   * The process owner's relay generation. It prefixes request IDs, so an answer to a request from
   * an earlier connection matches no request of this one.
   */
  readonly generation: Option.Option<number>;
}

/** A client of one bridge, scoped to the reading of its output. */
export interface BridgeClient {
  /**
   * Succeeds at the bridge's ready line, and fails if the output ends first. A bridge that a
   * process owner reattaches doesn't repeat the line.
   */
  readonly ready: Effect.Effect<void, SessionOperationError>;
  /**
   * OpenCode's events in arrival order, for one consumer. The stream ends when the output ends
   * after `close`, and fails when the output fails or ends otherwise.
   */
  readonly events: Stream.Stream<OpenCodeEvent, SessionOperationError>;
  /**
   * Sends `request` and waits up to 60 seconds for OpenCode's answer, with any HTTP status. Fails
   * with `operation` when the bridge can't reach OpenCode, the output ends first, or the client is
   * closing; after the output fails, returns that failure.
   */
  readonly request: (
    operation: SessionOperation,
    request: OpenCodeRequest,
  ) => Effect.Effect<BridgeAnswer, SessionOperationError>;
  /**
   * Sets the command environment of OpenCode session `session` to the bridge's own environment,
   * without the variables that the bridge sets on `serve` only, and returns OpenCode's answer as
   * `request` does.
   */
  readonly setToolEnvironment: (
    operation: SessionOperation,
    session: string,
  ) => Effect.Effect<BridgeAnswer, SessionOperationError>;
  /**
   * The messages that OpenCode sends to the client's MCP servers, and the reports that OpenCode
   * closed a server's socket, in arrival order, for one consumer. Ends and fails as `events` does.
   */
  readonly mcp: Stream.Stream<BridgeMcpMessage | BridgeMcpClosed, SessionOperationError>;
  /**
   * Attaches the client's MCP server `server` to OpenCode in `directory`, and returns OpenCode's
   * answer as `request` does: status 101 once a new socket is open, or 200 when the bridge already
   * holds the server's socket, such as a bridge that a process owner retained.
   */
  readonly connectMcp: (
    operation: SessionOperation,
    server: string,
    directory: string,
  ) => Effect.Effect<BridgeAnswer, SessionOperationError>;
  /**
   * Sends `message` to OpenCode over the socket of the client's MCP server `server`. The bridge
   * drops it while the socket is closed. Fails when the bridge's input is closed or its output
   * failed, and with `BridgeLineTooLong`, without writing it, when its line is longer than
   * `MAX_PROTOCOL_LINE_BYTES`.
   */
  readonly sendMcp: (
    server: string,
    message: McpMessage,
  ) => Effect.Effect<void, SessionOperationError | BridgeLineTooLong>;
  /**
   * Ends the bridge's input. The bridge then ends OpenCode's input and exits with OpenCode's exit
   * code, and requests that wait for an answer fail.
   */
  readonly close: Effect.Effect<void>;
}

/**
 * Starts reading the output of the bridge in `streams` and returns its client. Lines that aren't
 * bridge output, such as an event without a `type`, are logged and skipped. A line longer than
 * `MAX_PROTOCOL_LINE_BYTES` fails the client as a failed output does.
 */
export const bridgeClient = Effect.fn("OpenCodeBridge.client")(function* (streams: BridgeStreams) {
  const sessionId = Option.getOrUndefined(streams.sessionId);
  yield* Effect.annotateCurrentSpan({ sessionId });
  const failure = (operation: SessionOperation, message: string, cause: unknown) =>
    SessionOperationError.make({ operation, sessionId: streams.sessionId, message, cause });
  const ready = yield* Deferred.make<void, SessionOperationError>();
  const events = yield* Queue.make<OpenCodeEvent, SessionOperationError | Cause.Done>();
  const mcp = yield* Queue.make<
    BridgeMcpMessage | BridgeMcpClosed,
    SessionOperationError | Cause.Done
  >();
  const pending = yield* pendingRequests<BridgeAnswer>();
  const closing = yield* Ref.make(false);
  const failed = yield* Ref.make(Option.none<SessionOperationError>());

  const failAll = Effect.fn("OpenCodeBridge.failAll")(function* (error: SessionOperationError) {
    yield* Effect.annotateCurrentSpan({ sessionId });
    yield* Ref.update(
      failed,
      Option.orElseSome(() => error),
    );
    yield* Deferred.fail(ready, error);
    yield* pending.rejectAll(() => error);
    yield* Queue.fail(events, error);
    yield* Queue.fail(mcp, error);
  });
  const ended = Effect.fn("OpenCodeBridge.ended")(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId });
    if (!(yield* Ref.get(closing)))
      return yield* failAll(
        failure("stream", "The OpenCode bridge's output ended", new Error("output ended")),
      );
    yield* Effect.logInfo("The OpenCode bridge's output ended after close", { sessionId });
    yield* Deferred.fail(
      ready,
      failure("launch", "The OpenCode bridge closed before it was ready", new Error("closed")),
    );
    yield* pending.rejectAll((operation) =>
      failure(operation, "The OpenCode bridge closed before it answered", new Error("closed")),
    );
    yield* Queue.end(events);
    yield* Queue.end(mcp);
  });

  // Handles one output line, without a span.
  const route = (line: string) =>
    Effect.gen(function* () {
      if (line.trim().length === 0) return;
      const decoded = yield* decodeOutput(line).pipe(
        Effect.asSome,
        Effect.catch((cause) =>
          Effect.logWarning("Skipping an unknown OpenCode bridge line", {
            cause,
            line: previewLine(line),
            sessionId,
          }).pipe(Effect.as(Option.none<BridgeOutput>())),
        ),
      );
      if (Option.isNone(decoded)) return;
      const output = decoded.value;
      if (Schema.is(BridgeReady)(output)) return yield* Deferred.succeed(ready, undefined);
      if (Schema.is(BridgeEvent)(output)) return yield* Queue.offer(events, output.event);
      if (Schema.is(BridgeMcpMessage)(output) || Schema.is(BridgeMcpClosed)(output))
        return yield* Queue.offer(mcp, output);
      const found = yield* pending.take(output.id);
      if (Option.isNone(found))
        return yield* Effect.logInfo("Skipping an OpenCode bridge answer with no waiting request", {
          requestId: output.id,
          sessionId,
        });
      if (Schema.is(BridgeRequestFailed)(output))
        return yield* Deferred.fail(
          found.value.answer,
          failure(
            found.value.operation,
            `The OpenCode bridge couldn't complete the request: ${output.error}`,
            output,
          ),
        );
      yield* Deferred.succeed(found.value.answer, output);
    });

  yield* boundedLines(streams.output, () =>
    failure(
      "stream",
      `The OpenCode bridge wrote a line longer than ${MAX_PROTOCOL_LINE_BYTES} bytes`,
      new Error("line too long"),
    ),
  ).pipe(
    Stream.runForEach(route),
    Effect.flatMap(ended),
    Effect.tapError((error) =>
      Effect.logWarning("The OpenCode bridge's output failed", {
        message: error.message,
        sessionId,
      }),
    ),
    Effect.catch(failAll),
    Effect.forkScoped,
  );

  /** Returns the bytes of `line`, unless the client is closing or its output failed. */
  const encodeLine = (operation: SessionOperation, target: string, line: BridgeInput) =>
    Effect.gen(function* () {
      if (yield* Ref.get(closing))
        return yield* failure(operation, "The OpenCode bridge is closing", new Error("closing"));
      const previous = yield* Ref.get(failed);
      if (Option.isSome(previous)) return yield* previous.value;
      const encoded = yield* encodeInput(line).pipe(
        Effect.mapError((cause) =>
          failure(operation, `Invalid OpenCode bridge input for ${target}`, cause),
        ),
      );
      return encoder.encode(`${encoded}\n`);
    });
  /** Writes the bytes of a line to the bridge's input. */
  const writeLine = (operation: SessionOperation, bytes: Uint8Array) =>
    Effect.gen(function* () {
      if (!(yield* Queue.offer(streams.input, bytes)))
        return yield* failure(
          operation,
          "The OpenCode bridge's input is closed",
          new Error("closed"),
        );
    });
  /** Writes `line` to the bridge's input, unless the client is closing or its output failed. */
  const write = (operation: SessionOperation, target: string, line: BridgeInput) =>
    encodeLine(operation, target, line).pipe(
      Effect.flatMap((bytes) => writeLine(operation, bytes)),
    );

  /** Writes the input line that `line` returns for a request ID, and waits for its answer. */
  const send = (
    operation: SessionOperation,
    target: string,
    line: (id: BridgeRequestId) => BridgeInput,
  ) =>
    // The request is registered before the checks in `write`, so a failure after them rejects it.
    pending.send({
      operation,
      generation: streams.generation,
      write: (id: BridgeRequestId) => write(operation, target, line(id)),
      timedOut: (cause) =>
        failure(operation, `OpenCode didn't answer ${target} within ${cause.timeout}`, cause),
    });

  const request: BridgeClient["request"] = Effect.fn("OpenCodeBridge.request")(
    function* (operation, call) {
      yield* Effect.annotateCurrentSpan({
        operation,
        method: call.method,
        path: call.path,
        sessionId,
      });
      return yield* send(operation, `${call.method} ${call.path}`, (id) => ({ id, ...call }));
    },
  );

  const setToolEnvironment: BridgeClient["setToolEnvironment"] = Effect.fn(
    "OpenCodeBridge.setToolEnvironment",
  )(function* (operation, session) {
    yield* Effect.annotateCurrentSpan({ operation, openCodeSessionId: session, sessionId });
    return yield* send(operation, `the command environment of ${session}`, (id) => ({
      id,
      environment: session,
    }));
  });

  const connectMcp: BridgeClient["connectMcp"] = Effect.fn("OpenCodeBridge.connectMcp")(
    function* (operation, server, directory) {
      yield* Effect.annotateCurrentSpan({ operation, server, sessionId });
      return yield* send(operation, `the MCP server ${server}`, (id) => ({
        id,
        mcp: server,
        directory,
      }));
    },
  );

  const sendMcp: BridgeClient["sendMcp"] = (server, message) =>
    Effect.gen(function* () {
      const bytes = yield* encodeLine("stream", `a message of the MCP server ${server}`, {
        mcp: server,
        message,
      });
      // The bridge drops a longer line without an answer, so OpenCode would wait for it forever.
      const length = bytes.length - 1;
      if (length > MAX_PROTOCOL_LINE_BYTES)
        return yield* BridgeLineTooLong.make({
          server,
          bytes: length,
          message: `A message of the MCP server ${server} is longer than the ${MAX_PROTOCOL_LINE_BYTES} bytes of a bridge line`,
        });
      yield* writeLine("stream", bytes);
    });

  const close = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId });
    yield* Ref.set(closing, true);
    yield* Queue.end(streams.input);
  }).pipe(Effect.withSpan("OpenCodeBridge.close"));

  return {
    ready: Deferred.await(ready),
    events: Stream.fromQueue(events),
    mcp: Stream.fromQueue(mcp),
    connectMcp,
    sendMcp,
    request,
    setToolEnvironment,
    close,
  } satisfies BridgeClient;
});
