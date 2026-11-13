import { Effect, Redacted, Result, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type { HttpRouter } from "effect/http";
import type { Authentication } from "../auth/authentication.ts";
import { routedOperatorCall } from "../mcp/http.ts";
import type { OperatorCall } from "../mcp/server.ts";
import {
  type OperatorTool,
  operatorRequest,
  ToolArguments,
  toolResult,
  visibleTools,
} from "../mcp/tools.ts";

/** One operator tool as the harness contract defines it, with the MCP endpoint's input schema. */
const definition = (tool: OperatorTool) =>
  Tool.dynamic(tool.name, {
    description: tool.descriptor.description,
    parameters: tool.descriptor.inputSchema,
    success: Schema.String,
    failure: Schema.String,
  });

type OperatorToolDefinition = ReturnType<typeof definition>;

const decodeArguments = Schema.decodeUnknownEffect(ToolArguments);

/**
 * Calls the operation of `tool` with `args` through `call`. Returns the response text, cut at
 * the MCP endpoint's result limit; invalid arguments and responses outside 2xx fail with the
 * text that the model reads.
 */
const callOperatorTool = Effect.fn("Supervisor.callOperatorTool")(function* (
  tool: OperatorTool,
  args: ToolArguments,
  call: OperatorCall,
) {
  yield* Effect.annotateCurrentSpan({ tool: tool.name, operation: tool.operationId });
  const request = operatorRequest(tool, args);
  if (Result.isFailure(request)) {
    yield* Effect.logInfo("Supervisor tool call refused: invalid arguments", {
      tool: tool.name,
      reason: request.failure,
    });
    return yield* Effect.fail(request.failure);
  }
  const response = yield* call(request.success).pipe(
    Effect.catchTag("OperatorUnavailableError", ({ message }) =>
      Effect.logWarning("Supervisor tool call could not reach the operator API", {
        tool: tool.name,
        message,
      }).pipe(Effect.as({ status: 503, text: message })),
    ),
  );
  const result = toolResult(tool, response);
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  yield* Effect.logInfo("Supervisor called an operator tool", {
    tool: tool.name,
    status: response.status,
  });
  return result.isError === true ? yield* Effect.fail(text) : text;
});

/**
 * Returns the supervisor's operator toolkit over `tools`, with handlers that answer each call
 * through `call`. A refused or failed operation reaches the model as an error result.
 */
export const operatorToolkit = (tools: ReadonlyArray<OperatorTool>, call: OperatorCall) => {
  const toolkit = Toolkit.make(...tools.map(definition));
  const handlers = toolkit.toLayer(
    Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        (params: Tool.Parameters<OperatorToolDefinition>) =>
          decodeArguments(params).pipe(
            Effect.tapError(() =>
              Effect.logInfo("Supervisor tool call refused: arguments are not an object", {
                tool: tool.name,
              }),
            ),
            Effect.mapError(() => "Pass the arguments as a JSON object."),
            Effect.flatMap((args) => callOperatorTool(tool, args, call)),
          ),
      ]),
    ),
  );
  return { toolkit, handlers };
};

/**
 * Returns the supervisor's operator toolkit for the member whose credential is `secret`: the
 * operator tools that the MCP endpoint lists for the same credential, each answered by the
 * operator API through `router` with that credential. The route policy checks every call again,
 * so the supervisor can do no more than the member.
 */
export const memberOperatorToolkit = Effect.fn("Supervisor.memberToolkit")(function* (
  secret: Redacted.Redacted<string>,
  tools: ReadonlyArray<OperatorTool>,
  router: HttpRouter.HttpRouter,
  authentication: Authentication["Service"],
) {
  const access = yield* authentication.authenticate(Redacted.value(secret));
  const visible = visibleTools(tools, access.permissions, access.operations);
  yield* Effect.logInfo("Built the supervisor's operator toolkit", {
    tools: visible.length,
    hidden: tools.length - visible.length,
  });
  return operatorToolkit(
    visible,
    routedOperatorCall(router, { authorization: `Bearer ${Redacted.value(secret)}` }),
  );
});
