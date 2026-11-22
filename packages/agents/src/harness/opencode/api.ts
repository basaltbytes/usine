import type { AgentSessionId } from "@usine/core/agent/session";
import { Effect, Option, Schema } from "effect";
import { type SessionOperation, SessionOperationError } from "../../runtime.ts";
import type { BridgeClient } from "./bridge/client.ts";
import { type OpenCodeMethod, OpenCodePath } from "./bridge/lines.ts";
import { ApiError } from "./codec.ts";

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
}

/** Returns the API of the bridge that `client` talks to, with errors naming `sessionId`. */
export const openCodeApi = (
  client: Pick<BridgeClient, "request">,
  sessionId: Option.Option<AgentSessionId>,
): OpenCodeApi => {
  const failure = (operation: SessionOperation, message: string, cause: unknown) =>
    SessionOperationError.make({ operation, sessionId, message, cause });
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
      if (answer.status >= 200 && answer.status <= 299) return answer.body;
      const reason = Option.match(Schema.decodeUnknownOption(ApiError)(answer.body), {
        onNone: () => `status ${answer.status}`,
        onSome: ({ message }) => `status ${answer.status}: ${message}`,
      });
      return yield* failure(operation, `OpenCode refused ${method} ${target} (${reason})`, answer);
    },
  );
  return {
    send,
    read: (schema, operation, method, path, body) =>
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
      ),
  };
};

/** Returns `name=value` with both URL-encoded. */
export const query = (name: string, value: string) =>
  `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
