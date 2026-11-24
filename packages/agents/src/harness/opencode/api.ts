import type { AgentSessionId } from "@usine/core/agent/session";
import { Effect, Option, Schema } from "effect";
import { type SessionOperation, SessionOperationError } from "../../runtime.ts";
import type { BridgeClient } from "./bridge/client.ts";
import { BridgeAnswer, type OpenCodeMethod, OpenCodePath } from "./bridge/lines.ts";
import { ApiError, DeliveredMessage } from "./codec.ts";

/** OpenCode's API through one bridge, for one session or for none, as in preflight. */
export interface OpenCodeApi {
  /**
   * Sends `method` to `path`, a path and query with each value URL-encoded, and returns the body
   * of a 2xx response. Fails with `SessionOperationError` for another status, naming OpenCode's
   * message.
   */
  readonly send: (
    operation: SessionOperation,
    method: OpenCodeMethod,
    path: string,
    body?: Schema.Json,
  ) => Effect.Effect<Schema.Json, SessionOperationError>;
  /** Sends a request as `send` does and decodes the body with `schema`. */
  readonly read: <A, I>(
    schema: Schema.Codec<A, I>,
    operation: SessionOperation,
    method: OpenCodeMethod,
    path: string,
    body?: Schema.Json,
  ) => Effect.Effect<A, SessionOperationError>;
  /**
   * Sets the command environment of OpenCode session `session` to the worker's environment, which
   * the bridge has, so tool commands don't get the data and configuration directories of `serve`.
   */
  readonly setToolEnvironment: (
    operation: SessionOperation,
    session: string,
  ) => Effect.Effect<void, SessionOperationError>;
  /** Whether the saved session has delivered operator input `message` into its message history. */
  readonly messageDelivered: (
    session: string,
    message: string,
  ) => Effect.Effect<boolean, SessionOperationError>;
}

/** Returns the API of the bridge that `client` talks to, with errors naming `sessionId`. */
export const openCodeApi = (
  client: Pick<BridgeClient, "request" | "setToolEnvironment">,
  sessionId: Option.Option<AgentSessionId>,
): OpenCodeApi => {
  const failure = (operation: SessionOperation, message: string, cause: unknown) =>
    SessionOperationError.make({ operation, sessionId, message, cause });
  /** Returns the body of a 2xx `answer` to `target`, or fails naming OpenCode's message. */
  const accepted = (operation: SessionOperation, target: string, answer: BridgeAnswer) => {
    if (answer.status >= 200 && answer.status <= 299) return Effect.succeed(answer.body);
    const reason = Option.match(Schema.decodeUnknownOption(ApiError)(answer.body), {
      onNone: () => `status ${answer.status}`,
      onSome: ({ message }) => `status ${answer.status}: ${message}`,
    });
    return Effect.fail(failure(operation, `OpenCode refused ${target} (${reason})`, answer));
  };
  const send: OpenCodeApi["send"] = Effect.fn("OpenCodeApi.send")(
    function* (operation, method, target, body) {
      yield* Effect.annotateCurrentSpan({
        method,
        path: target,
        sessionId: Option.getOrUndefined(sessionId),
      });
      const path = yield* Schema.decodeEffect(OpenCodePath)(target).pipe(
        Effect.mapError((cause) => failure(operation, `Invalid OpenCode path ${target}`, cause)),
      );
      const answer = yield* client.request(
        operation,
        body === undefined ? { method, path } : { method, path, body },
      );
      return yield* accepted(operation, `${method} ${target}`, answer);
    },
  );
  const setToolEnvironment: OpenCodeApi["setToolEnvironment"] = Effect.fn(
    "OpenCodeApi.setToolEnvironment",
  )(function* (operation, session) {
    yield* Effect.annotateCurrentSpan({
      openCodeSessionId: session,
      sessionId: Option.getOrUndefined(sessionId),
    });
    const answer = yield* client.setToolEnvironment(operation, session);
    yield* accepted(operation, `the command environment of ${session}`, answer);
  });
  const read: OpenCodeApi["read"] = (schema, operation, method, path, body) =>
    send(operation, method, path, body).pipe(
      Effect.flatMap((answer) =>
        Schema.decodeUnknownEffect(schema)(answer).pipe(
          Effect.mapError((cause) =>
            failure(
              operation,
              `OpenCode answered ${method} ${path} with an unexpected body`,
              cause,
            ),
          ),
        ),
      ),
    );
  return {
    send,
    setToolEnvironment,
    read,
    messageDelivered: Effect.fn("OpenCodeApi.messageDelivered")(function* (session, message) {
      yield* Effect.annotateCurrentSpan({ openCodeSessionId: session, messageId: message });
      return yield* read(
        DeliveredMessage,
        "steer",
        "GET",
        `/api/session/${encodeURIComponent(session)}/message/${encodeURIComponent(message)}`,
      ).pipe(
        Effect.as(true),
        Effect.catchTag("SessionOperationError", (error) =>
          Schema.is(BridgeAnswer)(error.cause) && error.cause.status === 404
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      );
    }),
  };
};

/** Returns `name=value` with both URL-encoded. */
export const query = (name: string, value: string) =>
  `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
