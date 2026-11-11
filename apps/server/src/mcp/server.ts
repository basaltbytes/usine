import { type Brand, Context, Effect, Result, Schema } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import {
  type OperatorRequest,
  type OperatorResponse,
  type OperatorTool,
  ToolArguments,
  operatorRequest,
  toolResult,
} from "./tools.ts";

/** The MCP protocol revisions that the usine tool server accepts, newest first. */
export const MCP_PROTOCOLS = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
] as const;

/** The operator API could not answer a tool call's request. */
export class OperatorUnavailableError extends Schema.TaggedError<
  OperatorUnavailableError,
  Brand.Brand<"@usine/server/mcp/server/OperatorUnavailableError">
>()("OperatorUnavailableError", { message: Schema.String }) {}

/** Sends a tool call's request to the operator API with the caller's credential. */
export type OperatorCall = (
  request: OperatorRequest,
) => Effect.Effect<OperatorResponse, OperatorUnavailableError>;

const callTool = Effect.fn("Mcp.callTool")(function* (
  tool: OperatorTool,
  args: ToolArguments,
  call: OperatorCall,
) {
  yield* Effect.annotateCurrentSpan({ tool: tool.name, operation: tool.operationId });
  const request = operatorRequest(tool, args);
  if (Result.isFailure(request)) {
    yield* Effect.logInfo("MCP tool call refused: invalid arguments", {
      tool: tool.name,
      reason: request.failure,
    });
    return yield* McpSchema.InvalidParams.make({ message: request.failure });
  }
  const response = yield* call(request.success).pipe(
    Effect.catchTag("OperatorUnavailableError", ({ message }) =>
      Effect.logWarning("MCP tool call could not reach the operator API", {
        tool: tool.name,
        message,
      }).pipe(Effect.as({ status: 503, text: message })),
    ),
  );
  yield* Effect.logInfo("MCP tool called", { tool: tool.name, status: response.status });
  return toolResult(tool, response);
});

/** Registers each tool on the current MCP server. Calls go through `call`. */
export const registerOperatorTools = Effect.fn("Mcp.registerOperatorTools")(function* (
  tools: ReadonlyArray<OperatorTool>,
  call: OperatorCall,
) {
  const server = yield* McpServer.McpServer;
  for (const tool of tools)
    yield* server.addTool({
      tool: tool.descriptor,
      annotations: Context.empty(),
      handle: (payload) =>
        Schema.decodeUnknownEffect(ToolArguments)(payload ?? {}).pipe(
          Effect.mapError(() =>
            McpSchema.InvalidParams.make({ message: "Pass the arguments as a JSON object." }),
          ),
          Effect.flatMap((args) => callTool(tool, args, call)),
        ),
    });
  yield* Effect.logDebug("MCP tools registered", { count: tools.length });
});
