import type { AgentSessionId } from "@usine/core/agent/session";
import { type Cause, Deferred, Effect, Option, Queue, Ref, Schema, Stream } from "effect";
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
  BridgeRequestFailed,
  type BridgeRequestId,
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
      write: (id: BridgeRequestId) =>
        Effect.gen(function* () {
          if (yield* Ref.get(closing))
            return yield* failure(
              operation,
              "The OpenCode bridge is closing",
              new Error("closing"),
            );
          const previous = yield* Ref.get(failed);
          if (Option.isSome(previous)) return yield* previous.value;
          const encoded = yield* encodeInput(line(id)).pipe(
            Effect.mapError((cause) =>
              failure(operation, `Invalid OpenCode bridge input for ${target}`, cause),
            ),
          );
          if (!(yield* Queue.offer(streams.input, encoder.encode(`${encoded}\n`))))
            return yield* failure(
              operation,
              "The OpenCode bridge's input is closed",
              new Error("closed"),
            );
        }),
      timedOut: (timeout) =>
        failure(
          operation,
          `OpenCode didn't answer ${target} within ${timeout}`,
          new Error("request timed out"),
        ),
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

  const close = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId });
    yield* Ref.set(closing, true);
    yield* Queue.end(streams.input);
  }).pipe(Effect.withSpan("OpenCodeBridge.close"));

  return {
    ready: Deferred.await(ready),
    events: Stream.fromQueue(events),
    request,
    setToolEnvironment,
    close,
  } satisfies BridgeClient;
});
