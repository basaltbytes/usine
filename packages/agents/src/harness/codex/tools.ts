import type { AgentSessionId } from "@usine/core/agent/session";
import { Effect, Option, Schema } from "effect";
import {
  DynamicToolCallParams,
  type DynamicToolCallResponse,
  type DynamicToolNamespace,
  type ToolItem,
} from "../../protocol/codex/codex.ts";
import {
  callHostTool,
  decodeHostToolInput,
  type HostToolResult,
  type HostToolSet,
  hostToolNames,
} from "../tools.ts";
import { toolName } from "./codec.ts";
import type { CodexServerRequest } from "./connection.ts";

/** The namespace of usine tools; tools in it can't collide with Codex's own tools. */
const TOOL_NAMESPACE = "usine";

/**
 * Codex takes tool names of at most 128 characters and reserves `mcp`. It also refuses a name that
 * starts with `mcp__`, which fails `thread/start` with Codex's message.
 */
const toolNameRule = { maxLength: 128, reserved: new Set(["mcp"]) };

const decodeCall = Schema.decodeUnknownOption(DynamicToolCallParams);
const decodeJsonSchema = Schema.decodeUnknownEffect(Schema.Json);

const response = (result: HostToolResult): DynamicToolCallResponse => ({
  contentItems: [{ type: "inputText", text: result.text }],
  success: !result.isError,
});

/** How a Codex session serves its usine tools. */
interface CodexTools {
  /** The `thread/start` `dynamicTools`, or `None` for a session without usine tools. */
  readonly dynamicTools: Option.Option<ReadonlyArray<DynamicToolNamespace>>;
  /** Answers `item/tool/call`, and returns `None` for every other request. */
  readonly serve: (request: CodexServerRequest) => Option.Option<Effect.Effect<Schema.Json>>;
  /** The transcript name of a tool item: the toolkit name of a usine tool. */
  readonly toolName: (item: typeof ToolItem.Type) => string;
}

/**
 * Serves `tools` as client-served dynamic tools in the `usine` namespace. Codex sends each call
 * as an `item/tool/call` request on the session's connection, and a failed call reaches the model
 * as a tool error. A resumed thread restores the tools that it started with.
 */
export const serveCodexTools = Effect.fn("CodexRuntime.serveTools")(function* (
  tools: HostToolSet,
  sessionId: AgentSessionId,
) {
  const names = yield* hostToolNames(tools, toolNameRule);
  const call = callHostTool(tools, names);
  const answer = Effect.fn("CodexRuntime.answerToolCall")(function* (params: Schema.Json) {
    const decoded = decodeCall(params);
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning("Codex sent a tool call that usine can't read", { sessionId });
      return response({ isError: true, text: "usine couldn't read the tool call" });
    }
    const { namespace, tool, callId, arguments: input } = decoded.value;
    yield* Effect.annotateCurrentSpan({ sessionId, callId });
    // A dotted name matches no alias, so a tool outside the namespace is refused as unknown.
    const alias = namespace === TOOL_NAMESPACE ? tool : `${namespace ?? ""}.${tool}`;
    const result = yield* call(alias, decodeHostToolInput(input), Option.some(callId));
    return response(result);
  });
  const functions = yield* Effect.forEach(tools.tools, (tool) =>
    // The toolkit's JSON Schema is JSON, so only a defect fails here.
    decodeJsonSchema(tool.parameters).pipe(
      Effect.orDie,
      Effect.map((inputSchema) => ({
        type: "function" as const,
        name: names.alias(tool.name),
        description: tool.description,
        inputSchema,
      })),
    ),
  );
  return {
    dynamicTools:
      functions.length === 0
        ? Option.none()
        : Option.some([
            {
              type: "namespace",
              name: TOOL_NAMESPACE,
              description: "Tools that usine provides to this session.",
              tools: functions,
            },
          ]),
    serve: (request) =>
      request.method === "item/tool/call" ? Option.some(answer(request.params)) : Option.none(),
    toolName: (item) =>
      item.type === "dynamicToolCall" &&
      item.namespace === TOOL_NAMESPACE &&
      item.tool !== undefined
        ? Option.getOrElse(names.name(item.tool), () => toolName(item))
        : toolName(item),
  } satisfies CodexTools;
});
