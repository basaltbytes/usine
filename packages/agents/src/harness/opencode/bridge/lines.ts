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

/** The ID of an OpenCode session, such as `ses_dfda5480fffekNd7DilJmssCG2`. */
const OpenCodeSessionId = Schema.String.check(
  Schema.isPattern(/^ses_[A-Za-z0-9]+$/u, { message: "Expected an OpenCode session ID" }),
);

/**
 * A line on the bridge's standard input that sets the command environment of OpenCode session
 * `environment`: the bridge sends `PUT /api/session/<environment>/environment` with its own
 * environment, without the variables that it sets on `serve` only, and answers it as a request.
 */
const BridgeEnvironmentRequest = Schema.Struct({
  id: BridgeRequestId,
  environment: OpenCodeSessionId,
});

/** The name of an MCP server that the client hosts, as OpenCode accepts it. */
const McpServerName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u, {
    message: "Expected an MCP server name of letters, digits, underscores, and hyphens",
  }),
);

/** A JSON-RPC message of the MCP protocol: a JSON object. */
export const McpMessage = Schema.Record(Schema.String, Schema.Json);
export type McpMessage = typeof McpMessage.Type;

/**
 * A line on the bridge's standard input that attaches the client's MCP server `mcp` to OpenCode
 * in `directory`: the bridge opens OpenCode's client MCP socket for them and answers with status
 * 101 once the socket is open, or with 200 when the bridge already holds the socket of `mcp`. The
 * bridge reconnects a socket that OpenCode closes, until its input ends.
 */
export const BridgeMcpConnect = Schema.Struct({
  id: BridgeRequestId,
  mcp: McpServerName,
  directory: Schema.String,
});
export type BridgeMcpConnect = typeof BridgeMcpConnect.Type;

/**
 * A message of the client's MCP server `mcp`, in either direction: on the bridge's standard input,
 * the bridge sends `message` to OpenCode over the server's socket; on its standard output, OpenCode
 * sent `message` over it.
 */
export const BridgeMcpMessage = Schema.Struct({ mcp: McpServerName, message: McpMessage });
export type BridgeMcpMessage = typeof BridgeMcpMessage.Type;

/** A line on the bridge's standard input. */
export const BridgeInput = Schema.Union([
  BridgeRequest,
  BridgeEnvironmentRequest,
  BridgeMcpConnect,
  BridgeMcpMessage,
]);
export type BridgeInput = typeof BridgeInput.Type;

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

/**
 * The line that reports that OpenCode closed the socket of the client's MCP server `mcp`, with the
 * reason. The bridge then reconnects it, and OpenCode initializes the server again.
 */
export const BridgeMcpClosed = Schema.Struct({ mcp: McpServerName, closed: Schema.String });
export type BridgeMcpClosed = typeof BridgeMcpClosed.Type;

/** A line on the bridge's standard output. */
export const BridgeOutput = Schema.Union([
  BridgeReady,
  BridgeAnswer,
  BridgeRequestFailed,
  BridgeEvent,
  BridgeMcpMessage,
  BridgeMcpClosed,
]);
export type BridgeOutput = typeof BridgeOutput.Type;
