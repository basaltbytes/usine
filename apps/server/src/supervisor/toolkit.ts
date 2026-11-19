import type { PermissionRequest } from "@usine/core/permission-request";
import { Effect, Option, Redacted, Result, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type { HttpRouter } from "effect/http";
import type { Authentication } from "../auth/authentication.ts";
import { ceilingAdmits, type OperationId } from "../auth/model.ts";
import { routedOperatorCall } from "../mcp/http.ts";
import type { OperatorCall } from "../mcp/server.ts";
import {
  type OperatorTool,
  operatorRequest,
  ToolArguments,
  toolResult,
  visibleTools,
} from "../mcp/tools.ts";

/** What a turn's tool description adds for an operation that needs more than `read`. */
const GATED =
  "The call doesn't run at once: unless a member's standing grant covers it, usine stores a permission request, runs nothing, and the conversation's next turn gets the outcome once a member answers.";

/** One operator tool as the harness contract defines it, with the MCP endpoint's input schema. */
const definition = (tool: OperatorTool, note: Option.Option<string> = Option.none()) =>
  Tool.dynamic(tool.name, {
    description: Option.match(note, {
      onNone: () => tool.descriptor.description,
      onSome: (text) => `${tool.descriptor.description ?? ""} ${text}`.trim(),
    }),
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

/** Runs a gated call of `tool` with `args`; `toolCall` is the harness's ID of the call. */
export type GatedCall = (
  tool: OperatorTool,
  args: ToolArguments,
  toolCall: Option.Option<string>,
) => Effect.Effect<string, string>;

/** Decodes a tool call's parameters as arguments, or fails with what the model reads. */
const argumentsOf = (tool: OperatorTool, params: Tool.Parameters<OperatorToolDefinition>) =>
  decodeArguments(params).pipe(
    Effect.tapError(() =>
      Effect.logInfo("Supervisor tool call refused: arguments are not an object", {
        tool: tool.name,
      }),
    ),
    Effect.mapError(() => "Pass the arguments as a JSON object."),
  );

/**
 * Returns the supervisor's operator toolkit over `tools`, with handlers that answer each call
 * through `call`, and over `gated`, whose calls go to `gate`. A refused or failed operation
 * reaches the model as an error result.
 */
export const operatorToolkit = (
  tools: ReadonlyArray<OperatorTool>,
  call: OperatorCall,
  gated: ReadonlyArray<OperatorTool> = [],
  gate: GatedCall = () => Effect.fail("This tool needs a member's permission."),
) => {
  const toolkit = Toolkit.make(
    ...tools.map((tool) => definition(tool)),
    ...gated.map((tool) => definition(tool, Option.some(GATED))),
  );
  const handlers = toolkit.toLayer(
    Object.fromEntries([
      ...tools.map((tool) => [
        tool.name,
        (params: Tool.Parameters<OperatorToolDefinition>) =>
          argumentsOf(tool, params).pipe(
            Effect.flatMap((args) => callOperatorTool(tool, args, call)),
          ),
      ]),
      ...gated.map((tool) => [
        tool.name,
        (
          params: Tool.Parameters<OperatorToolDefinition>,
          context: Toolkit.HandlerContext<OperatorToolDefinition>,
        ) =>
          argumentsOf(tool, params).pipe(
            Effect.flatMap((args) => gate(tool, args, Option.fromUndefinedOr(context.toolCallId))),
          ),
      ]),
    ]),
  );
  return { toolkit, handlers };
};

/**
 * Returns the operator tools that need more than `read` and that the operation ceiling admits:
 * the operations whose calls a turn's requests gate.
 */
export const gatedTools = (
  tools: ReadonlyArray<OperatorTool>,
  ceiling: Option.Option<ReadonlyArray<OperationId>>,
): ReadonlyArray<OperatorTool> =>
  tools.filter(
    ({ permission, operationId }) =>
      (permission === "operate" || permission === "maintain" || permission === "admin") &&
      ceilingAdmits(ceiling, operationId),
  );

/** Returns the text that the model reads for a gated call's request, or fails with it. */
export const gatedResult = (request: PermissionRequest): Effect.Effect<string, string> => {
  const { call, state } = request;
  switch (state._tag) {
    case "Waiting":
      return Effect.succeed(
        `usine stored permission request ${request.id}: ${call.summary}, ${call.target}. Nothing ran. The request waits for a member's answer in the conversation. When every request of this turn has an answer, the conversation's next turn starts with the outcomes.`,
      );
    case "Ran":
      return Effect.succeed(state.result);
    case "Failed":
      return Effect.fail(state.error);
    case "Interrupted":
      return Effect.fail(
        "usine stopped before it stored the outcome, so the call may or may not have run.",
      );
    default:
      return Effect.fail(`The permission request is ${state._tag.toLowerCase()}.`);
  }
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
  gated: ReadonlyArray<OperatorTool> = [],
  gate?: GatedCall,
) {
  const access = yield* authentication.authenticate(Redacted.value(secret));
  const visible = visibleTools(tools, access.permissions, access.operations).filter(
    (tool) => !gated.includes(tool),
  );
  yield* Effect.logInfo("Built the supervisor's operator toolkit", {
    tools: visible.length,
    gated: gated.length,
    hidden: tools.length - visible.length - gated.length,
  });
  return operatorToolkit(
    visible,
    routedOperatorCall(router, { authorization: `Bearer ${Redacted.value(secret)}` }),
    gated,
    gate,
  );
});
