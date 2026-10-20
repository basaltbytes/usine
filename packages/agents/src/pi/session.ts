import {
  AgentSession,
  AgentSessionEvent,
  AgentSessionId,
  SessionFinished,
  SessionTokensUpdated,
  TokenCount,
  TextOutput,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
import { Cause, Deferred, Effect, Option, Queue, Ref, Schema } from "effect";
import { addUsage, piMessageUsage, type SessionUsage } from "./usage.ts";
import { type AgentSessionError, reportedOutcome, SessionResult } from "../runtime.ts";
import type { PiMessage, PiSession, PiSessionEvent } from "./sdk.ts";

export interface SessionChannelOptions {
  /** Adapter name printed in the terminal log lines. */
  readonly label: string;
  readonly sessionId: AgentSessionId;
}

/**
 * Shared session state: one event queue, one result, and a latch so exactly
 * one terminal transition wins. Cleanups registered through `onTerminal` run
 * on that transition.
 */
export interface SessionChannel {
  readonly events: Queue.Queue<AgentSessionEvent, AgentSessionError | Cause.Done>;
  readonly result: Deferred.Deferred<SessionResult, AgentSessionError>;
  readonly isTerminal: Effect.Effect<boolean>;
  readonly onTerminal: (cleanup: () => void) => void;
  /** Queues one event; after the terminal transition the event is logged and dropped. */
  readonly emit: (event: AgentSessionEvent) => Effect.Effect<void>;
  readonly fail: (error: AgentSessionError) => Effect.Effect<void>;
  readonly finish: (session: AgentSession, message: string) => Effect.Effect<void>;
}

export const sessionChannel = Effect.fn("SessionChannel.make")(function* (
  options: SessionChannelOptions,
) {
  const events = yield* Queue.make<AgentSessionEvent, AgentSessionError | Cause.Done>();
  const result = yield* Deferred.make<SessionResult, AgentSessionError>();
  const terminal = yield* Ref.make(false);
  const cleanups: Array<() => void> = [];
  const runCleanups = Effect.sync(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const emit = (event: AgentSessionEvent) =>
    Queue.offer(events, event).pipe(
      Effect.flatMap((accepted) =>
        accepted
          ? Effect.void
          : Effect.logWarning(`${options.label} dropped an event after the terminal transition`, {
              event: event._tag,
              sessionId: options.sessionId,
            }),
      ),
    );

  const fail = Effect.fn("SessionChannel.fail")(function* (error: AgentSessionError) {
    yield* Effect.annotateCurrentSpan({ sessionId: options.sessionId });
    if (yield* Ref.getAndSet(terminal, true)) return;
    yield* Effect.logError(`${options.label} failed`, {
      errorTag: error._tag,
      message: error.message,
      sessionId: options.sessionId,
    });
    yield* Deferred.fail(result, error);
    yield* Queue.fail(events, error);
    yield* runCleanups;
  });

  const finish = Effect.fn("SessionChannel.finish")(function* (
    session: AgentSession,
    message: string,
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: session.id });
    const own = reportedOutcome(Option.some(session.id), message);
    if (Option.isSome(own)) return yield* fail(own.value);
    if (yield* Ref.getAndSet(terminal, true)) return;
    yield* Queue.offer(events, new SessionFinished({ session }));
    yield* Deferred.succeed(result, new SessionResult({ message }));
    yield* Queue.end(events);
    yield* runCleanups;
    yield* Effect.logInfo(`${options.label} finished`, {
      sessionId: options.sessionId,
    });
  });

  return {
    events,
    result,
    isTerminal: Ref.get(terminal),
    onTerminal: (cleanup: () => void) => {
      cleanups.push(cleanup);
    },
    emit,
    fail,
    finish,
  } satisfies SessionChannel;
});

const PiAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});
const PiTextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const decodeSerializedJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
type PiToolStartedEvent = Extract<PiSessionEvent, { readonly type: "tool_execution_start" }>;
type PiToolFinishedEvent = Extract<PiSessionEvent, { readonly type: "tool_execution_end" }>;

const toolInputJson = (event: PiToolStartedEvent): Schema.Json => {
  try {
    return decodeSerializedJson(JSON.stringify(event.args) ?? "null");
  } catch {
    return String(event.args);
  }
};

const toolOutputJson = (event: PiToolFinishedEvent): Schema.Json => {
  try {
    return decodeSerializedJson(JSON.stringify(event.result) ?? "null");
  } catch {
    return String(event.result);
  }
};

const messageText = (message: PiMessage): string | undefined => {
  if (!Schema.is(PiAssistantMessage)(message)) return undefined;
  if (Schema.is(Schema.String)(message.content)) return message.content.trim() || undefined;
  const text = message.content
    .filter(Schema.is(PiTextBlock))
    .map(({ text }) => text)
    .join("")
    .trim();
  return text || undefined;
};

const PiUserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});

/** The text of a user message, as Pi compares it with the messages it queued; none for any other message. */
export const piUserMessageText = (message: PiMessage): Option.Option<string> => {
  if (!Schema.is(PiUserMessage)(message)) return Option.none();
  if (Schema.is(Schema.String)(message.content)) return Option.some(message.content);
  return Option.some(
    message.content
      .filter(Schema.is(PiTextBlock))
      .map(({ text }) => text)
      .join(""),
  );
};

export const lastPiMessageText = (messages: ReadonlyArray<PiMessage>): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const text = messageText(message);
    if (text !== undefined) return text;
  }
  return undefined;
};

const sessionEventFrom = (
  event: PiSessionEvent,
  session: AgentSession,
): AgentSessionEvent | undefined => {
  if (event.type === "message_end") {
    const text = messageText(event.message);
    return text === undefined ? undefined : new TextOutput({ session, text });
  }
  if (event.type === "tool_execution_start") {
    return new ToolStarted({
      session,
      callId: event.toolCallId,
      tool: event.toolName,
      input: toolInputJson(event),
    });
  }
  if (event.type === "tool_execution_end") {
    return new ToolFinished({
      session,
      callId: event.toolCallId,
      tool: event.toolName,
      output: toolOutputJson(event),
      isError: event.isError,
    });
  }
  return undefined;
};

/**
 * Subscribes the Pi SDK's synchronous listener to one session channel.
 * Normalized events reach the queue on the SDK's own tick so none can trail
 * the prompt's resolution; operational events with no normalized shape (retry
 * backoffs, compactions) are logged so a silent wait stays explainable.
 */
export const subscribePiSession = (
  piSession: PiSession,
  session: AgentSession,
  channel: SessionChannel,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const log = Effect.runForkWith(context);
    let lastText: string | undefined;
    let total: SessionUsage = { totalTokens: TokenCount.make(0), costUsd: Option.none() };
    const unsubscribe = piSession.subscribe((event) => {
      if (event.type === "message_end") {
        const usage = piMessageUsage(event.message);
        if (Option.isSome(usage)) {
          total = addUsage(total, usage.value);
          if (!Queue.offerUnsafe(channel.events, new SessionTokensUpdated({ session, ...total }))) {
            log(
              Effect.logWarning("Dropped Pi usage after the terminal transition", {
                sessionId: session.id,
              }),
            );
          }
        }
      }
      if (event.type === "auto_retry_start") {
        log(
          Effect.logWarning("Pi session is backing off before a retry", {
            attempt: event.attempt,
            delayMillis: event.delayMs,
            errorMessage: event.errorMessage,
            maxAttempts: event.maxAttempts,
            sessionId: session.id,
          }),
        );
        return;
      }
      if (event.type === "auto_retry_end") {
        log(
          Effect.logInfo("Pi session finished retrying", {
            attempt: event.attempt,
            finalError: event.finalError,
            sessionId: session.id,
            success: event.success,
          }),
        );
        return;
      }
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        log(
          Effect.logInfo("Pi session context compaction", {
            phase: event.type,
            reason: event.reason,
            sessionId: session.id,
          }),
        );
        return;
      }
      const sessionEvent = sessionEventFrom(event, session);
      if (sessionEvent === undefined) return;
      if (sessionEvent._tag === "TextOutput") lastText = sessionEvent.text;
      if (!Queue.offerUnsafe(channel.events, sessionEvent)) {
        log(
          Effect.logWarning("Dropped a Pi session event after the terminal transition", {
            event: sessionEvent._tag,
            sessionId: session.id,
          }),
        );
      }
    });
    channel.onTerminal(unsubscribe);
    return { lastText: () => lastText, unsubscribe };
  });
