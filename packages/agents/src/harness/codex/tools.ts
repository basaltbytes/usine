import type { AgentSessionId } from "@usine/core/agent/session";
import { Effect, Fiber, Option, Schema } from "effect";
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

/** A call whose answer is pending. */
interface PendingCall {
  /** Set when Codex no longer waits for the answer. */
  cancelled: boolean;
  /** The fiber that answers the call, once the answer starts. */
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
}

/** How a Codex session serves its usine tools. */
interface CodexTools {
  /** The `thread/start` `dynamicTools`, or `None` for a session without usine tools. */
  readonly dynamicTools: Option.Option<ReadonlyArray<DynamicToolNamespace>>;
  /** Answers `item/tool/call`, and returns `None` for every other request. */
  readonly serve: (request: CodexServerRequest) => Option.Option<Effect.Effect<Schema.Json>>;
  /**
   * Interrupts the call `callId` if its answer is pending, such as when Codex completes the item
   * of a call that it cancelled. Codex drops a late answer, so the handler stops instead.
   */
  readonly cancel: (callId: string) => Effect.Effect<void>;
  /** Interrupts every pending call, such as when the turn ends or the transport is lost. */
  readonly cancelAll: Effect.Effect<void>;
  /** The transcript name of a tool item: the toolkit name of a usine tool. */
  readonly toolName: (item: typeof ToolItem.Type) => string;
}

/**
 * Serves `tools` as client-served dynamic tools in the `usine` namespace. Codex sends each call
 * as an `item/tool/call` request on the session's connection, and a failed call reaches the model
 * as a tool error. A resumed thread restores the tools that it started with. The session cancels a
 * pending call when Codex stops waiting for its answer, and its handler is interrupted.
 */
export const serveCodexTools = Effect.fn("CodexRuntime.serveTools")(function* (
  tools: HostToolSet,
  sessionId: AgentSessionId,
) {
  const names = yield* hostToolNames(tools, toolNameRule);
  const call = callHostTool(tools, names);
  // The pending calls by call ID. `serve` registers a call before its answer starts, so a call
  // that Codex completes first is cancelled before its handler runs.
  const pending = new Map<string, PendingCall>();
  const forget = (callId: string, entry: PendingCall) =>
    Effect.sync(() => {
      if (pending.get(callId) === entry) pending.delete(callId);
    });
  const answer = Effect.fn("CodexRuntime.answerToolCall")(function* (
    params: typeof DynamicToolCallParams.Type,
    entry: PendingCall,
  ) {
    const { namespace, tool, callId, arguments: input } = params;
    yield* Effect.annotateCurrentSpan({ sessionId, callId });
    if (entry.cancelled) return yield* Effect.interrupt;
    entry.fiber = yield* Effect.fiber;
    // A dotted name matches no alias, so a tool outside the namespace is refused as unknown.
    const alias = namespace === TOOL_NAMESPACE ? tool : `${namespace ?? ""}.${tool}`;
    const result = yield* call(alias, decodeHostToolInput(input), Option.some(callId));
    return response(result);
  });
  const unreadable = Effect.fn("CodexRuntime.answerToolCall")(function* () {
    yield* Effect.annotateCurrentSpan({ sessionId });
    yield* Effect.logWarning("Codex sent a tool call that usine can't read", { sessionId });
    return response({ isError: true, text: "usine couldn't read the tool call" });
  });
  const interruptCall = (callId: string, entry: PendingCall) =>
    Effect.gen(function* () {
      pending.delete(callId);
      entry.cancelled = true;
      yield* Effect.logInfo("Cancelling a usine tool call that Codex no longer waits for", {
        sessionId,
        callId,
      });
      if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber);
    });
  const cancel = Effect.fn("CodexRuntime.cancelToolCall")(function* (callId: string) {
    const entry = pending.get(callId);
    if (entry !== undefined) yield* interruptCall(callId, entry);
  });
  const cancelAll = Effect.suspend(() =>
    Effect.forEach([...pending], ([callId, entry]) => interruptCall(callId, entry), {
      discard: true,
    }),
  ).pipe(Effect.withSpan("CodexRuntime.cancelToolCalls", { attributes: { sessionId } }));
  const serve = (request: CodexServerRequest): Option.Option<Effect.Effect<Schema.Json>> => {
    if (request.method !== "item/tool/call") return Option.none();
    const decoded = decodeCall(request.params);
    if (Option.isNone(decoded)) return Option.some(unreadable());
    const { callId } = decoded.value;
    const entry: PendingCall = { cancelled: false, fiber: undefined };
    pending.set(callId, entry);
    return Option.some(answer(decoded.value, entry).pipe(Effect.ensuring(forget(callId, entry))));
  };
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
    serve,
    cancel,
    cancelAll,
    toolName: (item) =>
      item.type === "dynamicToolCall" &&
      item.namespace === TOOL_NAMESPACE &&
      item.tool !== undefined
        ? Option.getOrElse(names.name(item.tool), () => toolName(item))
        : toolName(item),
  } satisfies CodexTools;
});
