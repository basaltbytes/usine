import {
  query as openClaudeQuery,
  type Options,
  type HookCallback,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionEvent,
  ChildSession,
  SessionStarted,
  SessionTokensUpdated,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { Context, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import {
  AgentResultError,
  ClaudeChildBackend,
  ChildBackend,
  type ChildRequest,
  type RunningSession,
  SessionOperationError,
  UnknownModelError,
} from "../runtime.ts";
import { sessionChannel } from "./session.ts";
import { sessionConversation } from "./conversation.ts";
import { claudeTokenMeter } from "./usage.ts";

export interface ClaudeUserMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string };
  readonly parent_tool_use_id: null;
}

export type ClaudeQueryOptions = Pick<
  Options,
  | "allowDangerouslySkipPermissions"
  | "cwd"
  | "effort"
  | "model"
  | "pathToClaudeCodeExecutable"
  | "permissionMode"
  | "persistSession"
  | "settingSources"
  | "thinking"
  | "hooks"
>;

export interface ClaudeModelInfo {
  readonly value: string;
  readonly resolvedModel?: string;
}

/** A live Claude Code session with its messages, model discovery, and stop controls. */
export interface ClaudeQuery extends AsyncIterable<Schema.Json> {
  readonly close: () => void;
  readonly interrupt: () => Promise<void>;
  readonly supportedModels: () => Promise<ReadonlyArray<ClaudeModelInfo>>;
}

/** Opens Claude Code sessions with the supplied task input and session settings. */
export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    readonly open: (
      input: AsyncIterable<ClaudeUserMessage>,
      options: ClaudeQueryOptions,
    ) => ClaudeQuery;
  }
>()("@usine/agents/pi/ClaudeSdk") {}

const decodeVendorMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const vendorMessageJson = (message: SDKMessage): Schema.Json =>
  decodeVendorMessage(JSON.stringify(message));

/** Provides Claude Code's session creation and model discovery. */
export const claudeSdkLive = Layer.succeed(ClaudeSdk)({
  open: (input, options) => {
    // SAFETY: ClaudeUserMessage is the streaming-input subset of SDKUserMessage.
    const query = openClaudeQuery({ prompt: input as AsyncIterable<SDKUserMessage>, options });
    return {
      close: () => query.close(),
      interrupt: async () => {
        await query.interrupt();
      },
      supportedModels: () => query.supportedModels(),
      async *[Symbol.asyncIterator]() {
        for await (const message of query) yield vendorMessageJson(message);
      },
    };
  },
});

class AsyncInput implements AsyncIterable<ClaudeUserMessage> {
  readonly #buffer: Array<ClaudeUserMessage> = [];
  readonly #waiters: Array<(value: IteratorResult<ClaudeUserMessage>) => void> = [];
  #ended = false;

  offer(message: ClaudeUserMessage): void {
    if (this.#ended) throw new Error("Claude input is closed");
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#buffer.push(message);
    else waiter({ done: false, value: message });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeUserMessage> {
    return {
      next: () => {
        const value = this.#buffer.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

const userMessage = (content: string): ClaudeUserMessage => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
});

const operationError = (
  operation: SessionOperationError["operation"],
  request: ChildRequest,
  message: string,
  cause: unknown,
): SessionOperationError =>
  new SessionOperationError({
    operation,
    sessionId: Option.some(request.session.id),
    message,
    cause,
  });

const optionsFor = (request: ChildRequest): ClaudeQueryOptions => {
  const effort = request.session.brain.effort;
  const shared: Omit<ClaudeQueryOptions, "effort" | "thinking"> = {
    allowDangerouslySkipPermissions: true,
    cwd: request.cwd,
    model: request.session.brain.model,
    // Use the same worker-provisioned binary that readiness checks inspect.
    pathToClaudeCodeExecutable: "claude",
    permissionMode: "bypassPermissions",
    persistSession: false,
    // The worktree is repository-controlled input. Its project and local
    // settings (hooks, env) must not load into a child that runs with the App
    // credential, so only the worker user's settings apply.
    settingSources: ["user"],
  };
  return effort === "off"
    ? { ...shared, thinking: { type: "disabled" } }
    : {
        ...shared,
        effort: effort === "minimal" ? "low" : effort,
        thinking: { type: "adaptive" },
      };
};

const modelExists = (models: ReadonlyArray<ClaudeModelInfo>, model: ModelId): boolean =>
  models.some((candidate) => candidate.value === model || candidate.resolvedModel === model);

const ClaudeTextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.NonEmptyString,
});
const ClaudeContentMessage = Schema.Struct({
  type: Schema.Literals(["assistant", "user"]),
  message: Schema.Struct({ content: Schema.Array(Schema.Json) }),
});
const ClaudeToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  input: Schema.Json,
});
const ClaudeToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.NonEmptyString,
  content: Schema.Json,
  is_error: Schema.optionalKey(Schema.Boolean),
});
const ClaudeResultMessage = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  result: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
  queued_turn_count: Schema.optionalKey(Schema.Number),
});

const sessionEventsFrom = (
  message: Schema.Json,
  session: ChildSession,
  tools: Map<string, string>,
): ReadonlyArray<AgentSessionEvent> => {
  if (!Schema.is(ClaudeContentMessage)(message)) return [];
  const events: Array<AgentSessionEvent> = [];
  for (const block of message.message.content) {
    // Emit each text block from a completed assistant message; streaming deltas
    // do not enter the transcript.
    if (message.type === "assistant" && Schema.is(ClaudeTextBlock)(block)) {
      events.push(new TextOutput({ session, text: block.text }));
    } else if (Schema.is(ClaudeToolUseBlock)(block)) {
      tools.set(block.id, block.name);
      events.push(
        new ToolStarted({
          session,
          callId: block.id,
          tool: block.name,
          input: block.input,
        }),
      );
    } else if (Schema.is(ClaudeToolResultBlock)(block)) {
      events.push(
        new ToolFinished({
          session,
          callId: block.tool_use_id,
          tool: tools.get(block.tool_use_id) ?? "unknown",
          output: block.content,
          isError: block.is_error === true,
        }),
      );
    }
  }
  return events;
};

const makeClaudeChild = Effect.gen(function* () {
  const sdk = yield* ClaudeSdk;

  const launch: ChildBackend["Service"]["launch"] = Effect.fn("ClaudeChildBackend.launch")(
    function* (request) {
      yield* Effect.annotateCurrentSpan({
        agent: request.session.agent,
        effort: request.session.brain.effort,
        harness: request.session.brain.harness,
        model: request.session.brain.model,
        parentSessionId: request.session.parentId,
        sessionId: request.session.id,
      });
      yield* Effect.logInfo("Launching Claude child session");
      const input = new AsyncInput();
      const context = yield* Effect.context<never>();
      const scope = yield* Effect.scope;
      let boundary = Effect.void;
      const pauseAtBoundary: HookCallback = async (_input, _id, options) => {
        await Effect.runPromiseWith(context)(
          Effect.acquireUseRelease(
            Effect.forkIn(
              Effect.suspend(() => boundary),
              scope,
            ),
            Fiber.join,
            Fiber.interrupt,
          ),
          { signal: options.signal },
        );
        return {};
      };
      const query = sdk.open(input, {
        ...optionsFor(request),
        hooks: {
          PreToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
          PostToolUse: [{ hooks: [pauseAtBoundary], timeout: 86_400 }],
        },
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          input.end();
          query.close();
        }),
      );
      const models = yield* Effect.tryPromise({
        try: () => query.supportedModels(),
        catch: (cause) => operationError("launch", request, "Claude model discovery failed", cause),
      });
      if (!modelExists(models, request.session.brain.model)) {
        yield* Effect.logError("Claude child rejected an unknown model");
        return yield* new UnknownModelError({
          harness: "claude",
          model: request.session.brain.model,
          message: `Claude does not expose model ${request.session.brain.model}`,
        });
      }

      const channel = yield* sessionChannel({
        label: "Claude child session",
        sessionId: request.session.id,
      });
      channel.onTerminal(() => {
        input.end();
      });
      const conversation = yield* sessionConversation({
        session: request.session,
        channel,
        send: (message) =>
          Effect.try({
            try: () => input.offer(userMessage(message)),
            catch: (cause) =>
              operationError("steer", request, "Could not send a message to Claude", cause),
          }),
        pause: Effect.void,
        beforeFinish: Effect.void,
      });
      boundary = conversation.awaitUnpaused;
      const tools = new Map<string, string>();
      const tokens = claudeTokenMeter();
      yield* channel.emit(new SessionStarted({ session: request.session }));
      input.offer(userMessage(request.prompt));

      const consume = Stream.fromAsyncIterable(query, (cause) =>
        operationError("stream", request, "Claude output stream failed", cause),
      ).pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            const totalTokens = tokens(message);
            if (Option.isSome(totalTokens))
              yield* channel.emit(
                new SessionTokensUpdated({
                  session: request.session,
                  totalTokens: totalTokens.value,
                }),
              );
            for (const event of sessionEventsFrom(message, request.session, tools)) {
              yield* channel.emit(event);
            }
            if (!Schema.is(ClaudeResultMessage)(message)) return;
            if (message.subtype !== "success" || message.result === undefined) {
              const detail = message.errors?.join("; ") ?? "Claude returned an unsuccessful result";
              yield* channel.fail(
                new AgentResultError({
                  sessionId: Option.some(request.session.id),
                  message: detail,
                }),
              );
              return;
            }
            if (message.queued_turn_count !== undefined && message.queued_turn_count > 0) {
              return;
            }
            yield* conversation.finish(message.result.trim() || "Claude child session completed");
          }),
        ),
        Effect.flatMap(() =>
          channel.isTerminal.pipe(
            Effect.flatMap((done) =>
              done
                ? Effect.void
                : channel.fail(
                    operationError(
                      "stream",
                      request,
                      "Claude output closed without a result",
                      new Error("unexpected end of output"),
                    ),
                  ),
            ),
          ),
        ),
        Effect.catch((error) => channel.fail(error)),
      );
      yield* Effect.forkScoped(consume);

      const steer = Effect.fn("ClaudeChildBackend.steer")((message: string) =>
        Effect.logDebug("Steering Claude child session", {
          sessionId: request.session.id,
        }).pipe(
          Effect.andThen(
            Effect.try({
              try: () => input.offer(userMessage(message)),
              catch: (cause) => operationError("steer", request, "Could not steer Claude", cause),
            }),
          ),
        ),
      );
      const interrupt = Effect.logInfo("Interrupting Claude child session", {
        sessionId: request.session.id,
      }).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => query.interrupt(),
            catch: (cause) =>
              operationError("interrupt", request, "Could not interrupt Claude", cause),
          }),
        ),
        Effect.tap(() => Effect.sync(() => input.end())),
        Effect.asVoid,
      );
      return {
        session: request.session,
        events: Stream.fromQueue(channel.events),
        interrupt,
        result: Deferred.await(channel.result),
        steer,
        intervene: conversation.intervene,
      } satisfies RunningSession;
    },
  );
  return ChildBackend.of({ launch });
});

/** Uses Claude Code for every task delegated through `ChildBackend`. */
export const claudeChildLayer = Layer.effect(ChildBackend, makeClaudeChild);
/** Provides the Claude Code backend for direct use or harness-based dispatch. */
export const claudeChildBackendLayer = Layer.effect(ClaudeChildBackend, makeClaudeChild);
