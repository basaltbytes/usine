import type { AgentSessionId } from "@usine/core/agent/session";
import { type Cause, Deferred, Effect, Option, Queue, Ref, Schema, Stream } from "effect";
import type { ProcessCommand } from "../../../child-host/process.ts";
import { type SessionOperation, SessionOperationError } from "../../../runtime.ts";
import { OPENCODE_BRIDGE } from "./bundle.js";
import {
  type BridgeAnswer,
  BridgeEvent,
  BridgeOutput,
  BridgeReady,
  BridgeRequest,
  BridgeRequestFailed,
  type BridgeRequestId,
  type OpenCodeEvent,
} from "./lines.ts";

const REQUEST_TIMEOUT = "60 seconds";
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeOutput));
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(BridgeRequest));
const encoder = new TextEncoder();
const preview = (line: string): string => (line.length > 200 ? `${line.slice(0, 200)}…` : line);

/**
 * Returns the command that runs the bridge in `opencode.cwd` around `opencode`, the OpenCode
 * command with any leading arguments. The bridge adds `serve` and its options, and runs with the
 * worker's `node`.
 */
export const bridgeCommand = (opencode: ProcessCommand): ProcessCommand => ({
  command: "node",
  args: ["-e", OPENCODE_BRIDGE, opencode.command, ...opencode.args],
  cwd: opencode.cwd,
});

/** A request to the OpenCode server: an upper-case HTTP method, a path from `/`, and a JSON body. */
interface OpenCodeRequest {
  readonly method: string;
  readonly path: string;
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
interface BridgeClient {
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
   * Ends the bridge's input. The bridge then ends OpenCode's input and exits with OpenCode's exit
   * code, and requests that wait for an answer fail.
   */
  readonly close: Effect.Effect<void>;
}

interface PendingRequest {
  readonly operation: SessionOperation;
  readonly answer: Deferred.Deferred<BridgeAnswer, SessionOperationError>;
}

/**
 * Starts reading the output of the bridge in `streams` and returns its client. Lines that aren't
 * bridge output, such as an event without a `type`, are logged and skipped.
 */
export const bridgeClient = Effect.fn("OpenCodeBridge.client")(function* (streams: BridgeStreams) {
  const sessionId = Option.getOrUndefined(streams.sessionId);
  yield* Effect.annotateCurrentSpan({ sessionId });
  const failure = (operation: SessionOperation, message: string, cause: unknown) =>
    SessionOperationError.make({ operation, sessionId: streams.sessionId, message, cause });
  const ready = yield* Deferred.make<void, SessionOperationError>();
  const events = yield* Queue.make<OpenCodeEvent, SessionOperationError | Cause.Done>();
  const pending = yield* Ref.make(new Map<BridgeRequestId, PendingRequest>());
  const nextId = yield* Ref.make(1);
  const closing = yield* Ref.make(false);
  const failed = yield* Ref.make(Option.none<SessionOperationError>());

  const take = (id: BridgeRequestId) =>
    Ref.modify(pending, (entries) => {
      const entry = entries.get(id);
      if (entry === undefined) return [Option.none<PendingRequest>(), entries];
      const remaining = new Map(entries);
      remaining.delete(id);
      return [Option.some(entry), remaining];
    });
  const rejectPending = (error: (operation: SessionOperation) => SessionOperationError) =>
    Effect.gen(function* () {
      const waiting = yield* Ref.getAndSet(pending, new Map());
      for (const entry of waiting.values())
        yield* Deferred.fail(entry.answer, error(entry.operation));
    });
  const failAll = Effect.fn("OpenCodeBridge.failAll")(function* (error: SessionOperationError) {
    yield* Effect.annotateCurrentSpan({ sessionId });
    yield* Ref.update(
      failed,
      Option.orElseSome(() => error),
    );
    yield* Deferred.fail(ready, error);
    yield* rejectPending(() => error);
    yield* Queue.fail(events, error);
  });
  const ended = Effect.fn("OpenCodeBridge.ended")(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId });
    if (!(yield* Ref.get(closing)))
      return yield* failAll(
        failure("stream", "The OpenCode bridge's output ended", new Error("output ended")),
      );
    yield* Effect.logDebug("The OpenCode bridge's output ended after close", { sessionId });
    yield* Deferred.fail(
      ready,
      failure("launch", "The OpenCode bridge closed before it was ready", new Error("closed")),
    );
    yield* rejectPending((operation) =>
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
            line: preview(line),
            sessionId,
          }).pipe(Effect.as(Option.none<BridgeOutput>())),
        ),
      );
      if (Option.isNone(decoded)) return;
      const output = decoded.value;
      if (Schema.is(BridgeReady)(output)) return yield* Deferred.succeed(ready, undefined);
      if (Schema.is(BridgeEvent)(output)) return yield* Queue.offer(events, output.event);
      const found = yield* take(output.id);
      if (Option.isNone(found))
        return yield* Effect.logDebug(
          "Ignoring an OpenCode bridge answer with no waiting request",
          {
            id: output.id,
            sessionId,
          },
        );
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

  yield* streams.output.pipe(
    Stream.decodeText(),
    Stream.splitLines,
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

  const request: BridgeClient["request"] = Effect.fn("OpenCodeBridge.request")(
    function* (operation, call) {
      yield* Effect.annotateCurrentSpan({
        operation,
        method: call.method,
        path: call.path,
        sessionId,
      });
      const sequence = yield* Ref.getAndUpdate(nextId, (current) => current + 1);
      const id = Option.match(streams.generation, {
        onNone: () => sequence,
        onSome: (generation) => `${generation}:${sequence}`,
      });
      const answer = yield* Deferred.make<BridgeAnswer, SessionOperationError>();
      // Registered before the checks, so that a failure after them rejects this request too.
      yield* Ref.update(pending, (entries) => new Map(entries).set(id, { operation, answer }));
      const forget = Effect.asVoid(take(id));
      if (yield* Ref.get(closing)) {
        yield* forget;
        return yield* failure(operation, "The OpenCode bridge is closing", new Error("closing"));
      }
      const previous = yield* Ref.get(failed);
      if (Option.isSome(previous)) {
        yield* forget;
        return yield* previous.value;
      }
      const line = yield* encodeRequest({ id, ...call }).pipe(Effect.orDie);
      if (!(yield* Queue.offer(streams.input, encoder.encode(`${line}\n`)))) {
        yield* forget;
        return yield* failure(
          operation,
          "The OpenCode bridge's input is closed",
          new Error("closed"),
        );
      }
      return yield* Deferred.await(answer).pipe(
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () =>
            forget.pipe(
              Effect.andThen(
                failure(
                  operation,
                  `OpenCode didn't answer ${call.method} ${call.path} within ${REQUEST_TIMEOUT}`,
                  new Error("request timed out"),
                ),
              ),
            ),
        }),
      );
    },
  );

  const close = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId });
    yield* Ref.set(closing, true);
    yield* Queue.end(streams.input);
  }).pipe(Effect.withSpan("OpenCodeBridge.close"));

  return {
    ready: Deferred.await(ready),
    events: Stream.fromQueue(events),
    request,
    close,
  } satisfies BridgeClient;
});
