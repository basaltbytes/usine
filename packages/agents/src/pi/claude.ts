import {
  query as openClaudeQuery,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Agent } from "@usine/core";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import {
  type AgentSessionError,
  ChildBackend,
  type ChildRequest,
  type RunningSession,
  SessionOperationError,
  SessionResult,
  UnknownModelError,
  UnsupportedHarnessError,
} from "../runtime.ts";

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
  | "includePartialMessages"
  | "model"
  | "permissionMode"
  | "persistSession"
  | "settingSources"
  | "thinking"
>;

export interface ClaudeModelInfo {
  readonly value: string;
  readonly resolvedModel?: string;
}

/** Narrow vendor seam: tests never need to imitate the SDK's large Query surface. */
export interface ClaudeQuery extends AsyncIterable<unknown> {
  readonly close: () => void;
  readonly interrupt: () => Promise<unknown>;
  readonly supportedModels: () => Promise<ReadonlyArray<ClaudeModelInfo>>;
}

export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    readonly open: (
      input: AsyncIterable<ClaudeUserMessage>,
      options: ClaudeQueryOptions,
    ) => ClaudeQuery;
  }
>()("@usine/agents/pi/ClaudeSdk") {}

export const claudeSdkLive = Layer.succeed(ClaudeSdk)({
  open: (input, options) =>
    openClaudeQuery({ prompt: input as AsyncIterable<SDKUserMessage>, options }),
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asJson = (value: unknown): Schema.Json => {
  try {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));
  } catch {
    return String(value);
  }
};

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
  return {
    allowDangerouslySkipPermissions: true,
    cwd: request.cwd,
    ...(effort === "off" ? {} : { effort: effort === "minimal" ? "low" : effort }),
    includePartialMessages: true,
    model: request.session.brain.model,
    permissionMode: "bypassPermissions",
    persistSession: false,
    settingSources: ["user", "project", "local"],
    thinking: effort === "off" ? { type: "disabled" } : { type: "adaptive" },
  };
};

const modelExists = (models: ReadonlyArray<ClaudeModelInfo>, model: Agent.ModelId): boolean =>
  models.some((candidate) => candidate.value === model || candidate.resolvedModel === model);

const activitiesFrom = (
  message: unknown,
  session: Agent.ChildSession,
  tools: Map<string, string>,
): ReadonlyArray<Agent.Activity> => {
  if (!isRecord(message)) return [];
  if (message.type === "stream_event" && isRecord(message.event)) {
    const event = message.event;
    if (
      event.type === "content_block_delta" &&
      isRecord(event.delta) &&
      event.delta.type === "text_delta" &&
      typeof event.delta.text === "string" &&
      event.delta.text.length > 0
    ) {
      return [new Agent.TextOutput({ session, text: event.delta.text })];
    }
    return [];
  }
  if ((message.type !== "assistant" && message.type !== "user") || !isRecord(message.message)) {
    return [];
  }
  const content = message.message.content;
  if (!Array.isArray(content)) return [];
  const activities: Array<Agent.Activity> = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      activities.push(new Agent.TextOutput({ session, text: block.text }));
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      block.id.length > 0 &&
      typeof block.name === "string" &&
      block.name.length > 0
    ) {
      tools.set(block.id, block.name);
      activities.push(
        new Agent.ToolStarted({
          session,
          callId: block.id,
          tool: block.name,
          input: asJson(block.input),
        }),
      );
    } else if (
      block.type === "tool_result" &&
      typeof block.tool_use_id === "string" &&
      block.tool_use_id.length > 0
    ) {
      activities.push(
        new Agent.ToolFinished({
          session,
          callId: block.tool_use_id,
          tool: tools.get(block.tool_use_id) ?? "unknown",
          output: asJson(block.content),
          isError: block.is_error === true,
        }),
      );
    }
  }
  return activities;
};

const makeClaudeChild = Effect.gen(function* () {
  const sdk = yield* ClaudeSdk;

  const launch: ChildBackend["Service"]["launch"] = Effect.fn("ClaudeChildBackend.launch")(
    function* (request) {
      if (request.session.brain.harness !== "claude") {
        return yield* new UnsupportedHarnessError({
          harness: request.session.brain.harness,
          message: `Claude backend cannot run ${request.session.brain.harness}`,
        });
      }
      const input = new AsyncInput();
      const query = sdk.open(input, optionsFor(request));
      const models = yield* Effect.tryPromise({
        try: () => query.supportedModels(),
        catch: (cause) => operationError("launch", request, "Claude model discovery failed", cause),
      });
      if (!modelExists(models, request.session.brain.model)) {
        input.end();
        query.close();
        return yield* new UnknownModelError({
          harness: "claude",
          model: request.session.brain.model,
          message: `Claude does not expose model ${request.session.brain.model}`,
        });
      }

      const events = yield* Queue.make<Agent.Activity, AgentSessionError | Cause.Done>();
      const result = yield* Deferred.make<SessionResult, AgentSessionError>();
      const terminal = yield* Ref.make(false);
      const tools = new Map<string, string>();
      yield* Queue.offer(events, new Agent.SessionStarted({ session: request.session }));
      input.offer(userMessage(request.prompt));

      const fail = Effect.fn("ClaudeChildBackend.fail")(function* (error: AgentSessionError) {
        if (yield* Ref.getAndSet(terminal, true)) return;
        yield* Deferred.fail(result, error);
        yield* Queue.fail(events, error);
        input.end();
      });

      const consume = Stream.fromAsyncIterable(query, (cause) =>
        operationError("stream", request, "Claude output stream failed", cause),
      ).pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            for (const activity of activitiesFrom(message, request.session, tools)) {
              yield* Queue.offer(events, activity);
            }
            if (!isRecord(message) || message.type !== "result") return;
            if (message.subtype !== "success" || typeof message.result !== "string") {
              const detail = Array.isArray(message.errors)
                ? message.errors.map(String).join("; ")
                : "Claude returned an unsuccessful result";
              yield* fail(
                operationError("stream", request, "Claude child session failed", new Error(detail)),
              );
              return;
            }
            if (typeof message.queued_turn_count === "number" && message.queued_turn_count > 0) {
              return;
            }
            if (yield* Ref.getAndSet(terminal, true)) return;
            const text = message.result.trim() || "Claude child session completed";
            yield* Queue.offer(events, new Agent.SessionFinished({ session: request.session }));
            yield* Deferred.succeed(result, new SessionResult({ message: text }));
            yield* Queue.end(events);
            input.end();
          }),
        ),
        Effect.flatMap(() =>
          Ref.get(terminal).pipe(
            Effect.flatMap((done) =>
              done
                ? Effect.void
                : fail(
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
        Effect.catch((error) => fail(error)),
      );
      yield* Effect.forkScoped(consume);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          input.end();
          query.close();
        }),
      );

      const steer = Effect.fn("ClaudeChildBackend.steer")((message: string) =>
        Effect.try({
          try: () => input.offer(userMessage(message)),
          catch: (cause) => operationError("steer", request, "Could not steer Claude", cause),
        }),
      );
      const interrupt = Effect.tryPromise({
        try: () => query.interrupt(),
        catch: (cause) => operationError("interrupt", request, "Could not interrupt Claude", cause),
      }).pipe(
        Effect.tap(() => Effect.sync(() => input.end())),
        Effect.asVoid,
      );
      return {
        events: Stream.fromQueue(events),
        interrupt,
        result: Deferred.await(result),
        steer,
      } satisfies RunningSession;
    },
  );
  return ChildBackend.of({ launch });
});

export const claudeChildLayer = Layer.effect(ChildBackend, makeClaudeChild);
