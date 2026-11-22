import { Schema } from "effect";

/**
 * The client's ID for a request, which the bridge copies into the answer: a sequence number, or a
 * string of at most 128 characters, such as `<generation>:<sequence>`, that keeps answers to an
 * earlier connection apart.
 */
export const BridgeRequestId = Schema.Union([
  Schema.Int,
  Schema.String.check(Schema.isMaxLength(128)),
]);
export type BridgeRequestId = typeof BridgeRequestId.Type;

/** An HTTP method of OpenCode's server API. */
export const OpenCodeMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type OpenCodeMethod = typeof OpenCodeMethod.Type;

/**
 * A request target on OpenCode's server in origin form: a path that starts with one `/`, and an
 * optional query, in printable ASCII without spaces.
 */
export const OpenCodePath = Schema.String.check(
  Schema.isPattern(/^\/(?!\/)[!-~]*$/u, {
    message: "Expected a path that starts with one / and has no spaces or non-ASCII characters",
  }),
).pipe(Schema.brand("OpenCodePath"));
export type OpenCodePath = typeof OpenCodePath.Type;

/**
 * A line on the bridge's standard input: the bridge sends `method` to `path` on the OpenCode
 * server, with `body` as JSON when it is present. The bridge checks the method and the path again,
 * and answers a request that it refuses with `BridgeRequestFailed`.
 */
export const BridgeRequest = Schema.Struct({
  id: BridgeRequestId,
  method: OpenCodeMethod,
  path: OpenCodePath,
  body: Schema.optionalKey(Schema.Json),
});
export type BridgeRequest = typeof BridgeRequest.Type;

/**
 * The bridge's line once OpenCode is listening and the bridge receives its events. Only answers to
 * requests that the bridge refuses come before it.
 */
export const BridgeReady = Schema.Struct({ ready: Schema.Literal(true) });
export type BridgeReady = typeof BridgeReady.Type;

/**
 * OpenCode's response to a request. `body` is the response's JSON value, `null` for an empty body,
 * or the text of a body that isn't JSON.
 */
export const BridgeAnswer = Schema.Struct({
  id: BridgeRequestId,
  status: Schema.Int,
  body: Schema.Json,
});
export type BridgeAnswer = typeof BridgeAnswer.Type;

/**
 * The answer to a request that the bridge refused or couldn't send, or whose response it didn't get
 * in full or couldn't fit in a line.
 */
export const BridgeRequestFailed = Schema.Struct({ id: BridgeRequestId, error: Schema.String });
export type BridgeRequestFailed = typeof BridgeRequestFailed.Type;

/** An event from OpenCode's `GET /api/event` stream. */
export const OpenCodeEvent = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json),
]);
export type OpenCodeEvent = typeof OpenCodeEvent.Type;

/** An event line, written in arrival order with the answers. */
export const BridgeEvent = Schema.Struct({ event: OpenCodeEvent });
export type BridgeEvent = typeof BridgeEvent.Type;

/** A line on the bridge's standard output. */
export const BridgeOutput = Schema.Union([
  BridgeReady,
  BridgeAnswer,
  BridgeRequestFailed,
  BridgeEvent,
]);
export type BridgeOutput = typeof BridgeOutput.Type;
