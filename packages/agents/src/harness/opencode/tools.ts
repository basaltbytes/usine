import type { AgentSessionId } from "@usine/core/agent/session";
import { Deferred, Effect, FiberMap, Option, Ref, Schema, type Scope, Stream } from "effect";
import { MAX_PROTOCOL_LINE_BYTES } from "../../child-host/lines.ts";
import { SessionOperationError } from "../../runtime.ts";
import {
  callHostTool,
  decodeHostToolInput,
  type HostToolResult,
  type HostToolSet,
  hostToolNames,
} from "../tools.ts";
import type { BridgeClient, BridgeLineTooLong } from "./bridge/client.ts";
import type { BridgeMcpClosed, BridgeMcpMessage, McpMessage } from "./bridge/lines.ts";
import { TOOL_SERVER } from "./config.ts";

/**
 * OpenCode names a tool `usine_<tool>`, and the OpenAI API takes function names of at most 64
 * characters.
 */
const toolNameRule = { maxLength: 64 - TOOL_SERVER.length - 1, reserved: new Set<string>() };
/** The MCP version that the server answers when OpenCode names none. */
const PROTOCOL_VERSION = "2025-11-25";
/** How long OpenCode has to list the tools of a new socket. */
const LIST_TIMEOUT = "30 seconds";
/** The key of `tools/call`'s `_meta` that names the calling OpenCode session. */
const SESSION_META = "ai.opencode/sessionID";

const RequestId = Schema.Union([Schema.String, Schema.Finite]);
type RequestId = typeof RequestId.Type;
const McpRequest = Schema.Struct({
  id: RequestId,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
});
const McpNotification = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Json),
});
const McpResponse = Schema.Struct({ id: RequestId });
const InitializeParams = Schema.Struct({ protocolVersion: Schema.optionalKey(Schema.String) });
const ToolCallParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Json),
  _meta: Schema.optionalKey(Schema.Struct({ [SESSION_META]: Schema.optionalKey(Schema.String) })),
});
const CancelledParams = Schema.Struct({ requestId: RequestId });

const decodeRequest = Schema.decodeUnknownOption(McpRequest);
const decodeNotification = Schema.decodeUnknownOption(McpNotification);
const decodeResponse = Schema.decodeUnknownOption(McpResponse);
const decodeInitialize = Schema.decodeUnknownOption(InitializeParams);
const decodeToolCall = Schema.decodeUnknownOption(ToolCallParams);
const decodeCancelled = Schema.decodeUnknownOption(CancelledParams);
const decodeJsonSchema = Schema.decodeUnknownEffect(Schema.Json);

const callResult = (result: HostToolResult): Schema.Json => ({
  content: [{ type: "text", text: result.text }],
  isError: result.isError,
});

/** The bridge operations that serve a client MCP server. */
export type McpConnection = Pick<BridgeClient, "mcp" | "connectMcp" | "sendMcp">;

/** How an OpenCode session serves its usine tools. */
export interface OpenCodeTools {
  /** The toolkit name of the OpenCode tool `name`, or `name` for a tool outside the toolkit. */
  readonly toolName: (name: string) => string;
  /**
   * Attaches the tools to OpenCode in `directory` as the client MCP server `TOOL_SERVER`, and
   * serves the calls of OpenCode session `root` until `connection`'s output ends. On a new socket,
   * waits until OpenCode has listed the tools and answered a ping, so the session's next step
   * lists them; when OpenCode closes the socket first, waits for the list on the next socket.
   * Fails with the relay's error when `connection`'s output ends or fails during the wait. A call
   * from another session, such as a subagent's, returns an error result, and so does a call whose
   * result is longer than a bridge line.
   */
  readonly attach: (
    connection: McpConnection,
    directory: string,
    root: string,
  ) => Effect.Effect<void, SessionOperationError, Scope.Scope>;
}

/**
 * Serves `tools` to an OpenCode session over the bridge's client MCP socket, answering OpenCode's
 * `initialize`, `ping`, `tools/list`, and `tools/call` requests. A `notifications/cancelled` for a
 * pending call interrupts its handler, and its answer is never sent.
 */
export const serveOpenCodeTools = Effect.fn("OpenCodeRuntime.serveTools")(function* (
  tools: HostToolSet,
  sessionId: AgentSessionId,
) {
  yield* Effect.annotateCurrentSpan({ sessionId });
  const names = yield* hostToolNames(tools, toolNameRule);
  const call = callHostTool(tools, names);
  const listing = yield* Effect.forEach(tools.tools, (tool) =>
    // The toolkit's JSON Schema is JSON, so only a defect fails here.
    decodeJsonSchema(tool.parameters).pipe(
      Effect.orDie,
      Effect.map((inputSchema) => ({
        name: names.alias(tool.name),
        description: tool.description,
        inputSchema,
      })),
    ),
  );
  const prefix = `${TOOL_SERVER}_`;
  const toolName = (name: string) =>
    name.startsWith(prefix)
      ? Option.getOrElse(names.name(name.slice(prefix.length)), () => name)
      : name;
  const pings = yield* Ref.make(0);
  /** The wait for one socket: OpenCode's list of the tools on it, and its close. */
  const socketWait = Effect.all({ listed: Deferred.make<void>(), closed: Deferred.make<void>() });

  const attach: OpenCodeTools["attach"] = Effect.fn("OpenCodeRuntime.attachTools")(function* (
    connection: McpConnection,
    directory: string,
    root: string,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId, harnessSessionId: root });
    const firstSocket = yield* socketWait;
    const socket = yield* Ref.make(firstSocket);
    /** The ping that the attach waits for OpenCode to answer. */
    const ping = yield* Ref.make(
      Option.none<{ readonly id: string; readonly answered: Deferred.Deferred<void> }>(),
    );
    /** Fails with the relay's error once `connection`'s output ends or fails. */
    const relayEnded = yield* Deferred.make<never, SessionOperationError>();
    const calls = yield* FiberMap.make<RequestId>();
    const unanswered = (error: SessionOperationError | BridgeLineTooLong) =>
      Effect.logWarning("Could not answer OpenCode's MCP request", {
        sessionId,
        message: error.message,
      });
    const reply = (message: McpMessage) =>
      connection.sendMcp(TOOL_SERVER, message).pipe(Effect.catch(unanswered));
    const answer = (id: RequestId, result: Schema.Json) => reply({ jsonrpc: "2.0", id, result });
    const refuse = (id: RequestId, code: number, message: string) =>
      reply({ jsonrpc: "2.0", id, error: { code, message } });

    const runCall = Effect.fn("OpenCodeRuntime.answerToolCall")(function* (
      id: RequestId,
      params: typeof ToolCallParams.Type,
    ) {
      yield* Effect.annotateCurrentSpan({ sessionId, requestId: id, tool: params.name });
      const caller = params._meta?.[SESSION_META];
      if (caller !== root) {
        yield* Effect.logWarning("OpenCode called a usine tool from another session; refusing it", {
          sessionId,
          tool: params.name,
          caller,
        });
        return yield* answer(
          id,
          callResult({
            isError: true,
            text: "usine tools serve only the session that opened them",
          }),
        );
      }
      const result = yield* call(
        params.name,
        decodeHostToolInput(params.arguments ?? {}),
        Option.some(String(id)),
      );
      return yield* connection
        .sendMcp(TOOL_SERVER, { jsonrpc: "2.0", id, result: callResult(result) })
        .pipe(
          Effect.catchTag("BridgeLineTooLong", (error) =>
            Effect.logWarning(
              "A usine tool's result is too long for the OpenCode bridge; answering with an error",
              { sessionId, tool: params.name, bytes: error.bytes },
            ).pipe(
              Effect.andThen(
                answer(
                  id,
                  callResult({
                    isError: true,
                    text: `The result of the usine tool ${params.name} is longer than the ${MAX_PROTOCOL_LINE_BYTES} bytes that usine relays to OpenCode`,
                  }),
                ),
              ),
            ),
          ),
          Effect.catch(unanswered),
        );
    });

    const request = Effect.fn("OpenCodeRuntime.answerMcpRequest")(function* (
      id: RequestId,
      method: string,
      params: Option.Option<Schema.Json>,
    ) {
      switch (method) {
        case "initialize": {
          const version = Option.flatMap(params, decodeInitialize).pipe(
            Option.flatMap(({ protocolVersion }) => Option.fromUndefinedOr(protocolVersion)),
            Option.getOrElse(() => PROTOCOL_VERSION),
          );
          return yield* answer(id, {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: TOOL_SERVER, version: "1.0.0" },
          });
        }
        case "ping":
          return yield* answer(id, {});
        case "tools/list":
          yield* answer(id, { tools: listing });
          yield* Effect.logDebug("Listed the usine tools to OpenCode", {
            sessionId,
            tools: listing.length,
          });
          const current = yield* Ref.get(socket);
          return yield* Deferred.succeed(current.listed, undefined);
        case "tools/call": {
          const decoded = Option.flatMap(params, decodeToolCall);
          if (Option.isNone(decoded)) {
            yield* Effect.logWarning("OpenCode sent a usine tool call that usine can't read", {
              sessionId,
            });
            return yield* refuse(id, -32602, "usine couldn't read the tool call");
          }
          yield* FiberMap.run(calls, id, runCall(id, decoded.value));
          return;
        }
        default:
          yield* Effect.logInfo("Refusing an MCP request that the usine tools don't serve", {
            sessionId,
            method,
          });
          return yield* refuse(id, -32601, `Method not found: ${method}`);
      }
    });

    const notification = Effect.fn("OpenCodeRuntime.mcpNotification")(function* (
      method: string,
      params: Option.Option<Schema.Json>,
    ) {
      if (method !== "notifications/cancelled") return;
      const cancelled = Option.flatMap(params, decodeCancelled);
      if (Option.isNone(cancelled))
        return yield* Effect.logWarning(
          "Skipping a cancel of a usine tool call that usine can't read; the call keeps running",
          { sessionId },
        );
      const { requestId } = cancelled.value;
      if (!(yield* FiberMap.has(calls, requestId)))
        return yield* Effect.logInfo("Skipping a cancel of a usine tool call that isn't running", {
          sessionId,
          requestId,
        });
      yield* Effect.logInfo("Cancelling a usine tool call that OpenCode no longer waits for", {
        sessionId,
        requestId,
      });
      yield* FiberMap.remove(calls, requestId);
    });

    /** Starts the wait for the next socket and ends the wait for the closed one. */
    const socketClosed = (reason: string) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(
          "OpenCode closed the usine tools' MCP socket; the bridge reconnects it",
          { sessionId, reason },
        );
        const next = yield* socketWait;
        const previous = yield* Ref.getAndSet(socket, next);
        yield* Deferred.succeed(previous.closed, undefined);
      });
    /** Answers the ping that the attach waits for, when `id` is its ID. */
    const response = (id: RequestId) =>
      Effect.gen(function* () {
        const pending = yield* Ref.get(ping);
        const waiting = Option.filter(pending, (current) => current.id === id);
        if (Option.isSome(waiting))
          return yield* Deferred.succeed(waiting.value.answered, undefined);
        yield* Effect.logWarning("Skipping an MCP answer that usine waits for no longer", {
          sessionId,
          requestId: id,
        });
      });

    const receive = (line: BridgeMcpMessage | BridgeMcpClosed) => {
      if ("closed" in line) return socketClosed(line.closed);
      if (line.mcp !== TOOL_SERVER)
        return Effect.logWarning("Skipping a message for another MCP server", {
          sessionId,
          server: line.mcp,
        });
      const { message } = line;
      const asRequest = decodeRequest(message);
      if (Option.isSome(asRequest))
        return request(
          asRequest.value.id,
          asRequest.value.method,
          Option.fromUndefinedOr(asRequest.value.params),
        );
      const asNotification = decodeNotification(message);
      if (Option.isSome(asNotification))
        return notification(
          asNotification.value.method,
          Option.fromUndefinedOr(asNotification.value.params),
        );
      const asResponse = decodeResponse(message);
      if (Option.isSome(asResponse)) return response(asResponse.value.id);
      return Effect.logWarning("Skipping an MCP message that usine can't read", { sessionId });
    };

    yield* connection.mcp.pipe(
      Stream.runForEach(receive),
      Effect.andThen(
        Effect.fail(
          SessionOperationError.make({
            operation: "launch",
            sessionId: Option.some(sessionId),
            message: "The usine tools' MCP relay ended with the bridge's output",
            cause: new Error("relay ended"),
          }),
        ),
      ),
      Effect.catch((error) =>
        Effect.logInfo("The usine tools' MCP relay ended with the bridge's output", {
          sessionId,
          message: error.message,
        }).pipe(Effect.andThen(Deferred.fail(relayEnded, error))),
      ),
      Effect.ensuring(FiberMap.clear(calls)),
      Effect.forkScoped,
    );

    const attached = yield* connection.connectMcp("launch", TOOL_SERVER, directory);
    if (attached.status === 200)
      return yield* Effect.logInfo("The retained OpenCode bridge already serves the usine tools", {
        sessionId,
      });
    if (attached.status !== 101)
      return yield* SessionOperationError.make({
        operation: "launch",
        sessionId: Option.some(sessionId),
        message: `OpenCode refused the usine tools' MCP socket (status ${attached.status})`,
        cause: attached,
      });
    /** Waits for the list and the ping's answer on the current socket, or on the next ones. */
    const listedOnSocket: Effect.Effect<void, SessionOperationError> = Effect.gen(function* () {
      const current = yield* Ref.get(socket);
      const pinged = Effect.gen(function* () {
        yield* Deferred.await(current.listed);
        const id = `usine-ping-${yield* Ref.updateAndGet(pings, (count) => count + 1)}`;
        const answered = yield* Deferred.make<void>();
        yield* Ref.set(ping, Option.some({ id, answered }));
        // OpenCode reads its socket in order, so its answer to the ping comes after it registered
        // the tools that it listed.
        yield* connection
          .sendMcp(TOOL_SERVER, { jsonrpc: "2.0", id, method: "ping" })
          // A ping always fits in a line.
          .pipe(Effect.catchTag("BridgeLineTooLong", (error) => Effect.die(error)));
        yield* Deferred.await(answered);
      }).pipe(Effect.ensuring(Ref.set(ping, Option.none())));
      const reconnected = yield* Effect.raceFirst(
        pinged.pipe(Effect.as(false)),
        Deferred.await(current.closed).pipe(Effect.as(true)),
      );
      if (!reconnected) return;
      yield* Effect.logInfo(
        "OpenCode closed the usine tools' socket before it answered; waiting for the next socket",
        { sessionId },
      );
      return yield* listedOnSocket;
    });
    yield* Effect.raceFirst(listedOnSocket, Deferred.await(relayEnded)).pipe(
      Effect.timeoutOrElse({
        duration: LIST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            SessionOperationError.make({
              operation: "launch",
              sessionId: Option.some(sessionId),
              message: `OpenCode didn't list the usine tools within ${LIST_TIMEOUT}`,
              cause: new Error("tool list timed out"),
            }),
          ),
      }),
    );
    yield* Effect.logInfo("Attached the usine tools to OpenCode", {
      sessionId,
      tools: listing.length,
    });
  });

  return { toolName, attach } satisfies OpenCodeTools;
});
