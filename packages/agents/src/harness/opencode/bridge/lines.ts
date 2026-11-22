import { Schema } from "effect";

/**
 * The client's ID for a request, which the bridge copies into the answer: a sequence number, or a
 * string such as `<generation>:<sequence>` that keeps answers to an earlier connection apart.
 */
export const BridgeRequestId = Schema.Union([Schema.Int, Schema.String]);
export type BridgeRequestId = typeof BridgeRequestId.Type;

/**
 * A line on the bridge's standard input: the bridge sends `method` to `path` on the OpenCode
 * server, with `body` as JSON when it is present. `method` is an upper-case HTTP method and `path`
 * starts with one `/`; the bridge answers another request with `BridgeRequestFailed`.
 */
export const BridgeRequest = Schema.Struct({
  id: BridgeRequestId,
  method: Schema.String,
  path: Schema.String,
  body: Schema.optionalKey(Schema.Json),
});
export type BridgeRequest = typeof BridgeRequest.Type;

/** The bridge's first line: OpenCode is listening and the bridge receives its events. */
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

/** The answer to a request that the bridge refused, couldn't send, or got no full response to. */
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
