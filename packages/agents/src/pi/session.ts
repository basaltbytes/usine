import { Agent } from "@usine/core";
import { Cause, Deferred, Effect, Queue, Ref, Schema } from "effect";
import { type AgentSessionError, SessionResult } from "../runtime.ts";
import type { PiMessage, PiSession, PiSessionEvent } from "./sdk.ts";

export interface SessionChannelOptions {
  /** Human-readable adapter name used in the terminal log lines. */
  readonly label: string;
  readonly sessionId: Agent.SessionId;
}

/**
 * Terminal-once state every session adapter shares: one event queue, one
 * result, and a latch guaranteeing exactly one terminal transition. Cleanups
 * registered through `onTerminal` run on whichever transition wins.
 */
export interface SessionChannel {
  readonly events: Queue.Queue<Agent.SessionEvent, AgentSessionError | Cause.Done>;
  readonly result: Deferred.Deferred<SessionResult, AgentSessionError>;
  readonly isTerminal: Effect.Effect<boolean>;
  readonly onTerminal: (cleanup: () => void) => void;
  /** Offers one event, logging instead of silently dropping it after the terminal transition. */
  readonly emit: (event: Agent.SessionEvent) => Effect.Effect<void>;
  readonly fail: (error: AgentSessionError) => Effect.Effect<void>;
  readonly finish: (session: Agent.Session, message: string) => Effect.Effect<void>;
}

export const sessionChannel = Effect.fn("SessionChannel.make")(function* (
  options: SessionChannelOptions,
) {
  const events = yield* Queue.make<Agent.SessionEvent, AgentSessionError | Cause.Done>();
  const result = yield* Deferred.make<SessionResult, AgentSessionError>();
  const terminal = yield* Ref.make(false);
  const cleanups: Array<() => void> = [];
  const runCleanups = Effect.sync(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const emit = (event: Agent.SessionEvent) =>
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
    session: Agent.Session,
    message: string,
  ) {
    if (yield* Ref.getAndSet(terminal, true)) return;
    yield* Queue.offer(events, new Agent.SessionFinished({ session }));
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
  session: Agent.Session,
): Agent.SessionEvent | undefined => {
  if (event.type === "message_end") {
    const text = messageText(event.message);
    return text === undefined ? undefined : new Agent.TextOutput({ session, text });
  }
  if (event.type === "tool_execution_start") {
    return new Agent.ToolStarted({
      session,
      callId: event.toolCallId,
      tool: event.toolName,
      input: toolInputJson(event),
    });
  }
  if (event.type === "tool_execution_end") {
    return new Agent.ToolFinished({
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
 * Bridges the Pi SDK's synchronous subscriber onto one session channel.
 * Normalized events reach the queue on the SDK's own tick — no async hop, so
 * nothing can trail the prompt's resolution — while operational events with
 * no normalized shape (retry backoffs, compactions) are logged through the
 * launch fiber's captured services so a silent wait stays explainable.
 */
export const subscribePiSession = (
  piSession: PiSession,
  session: Agent.Session,
  channel: SessionChannel,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const log = Effect.runForkWith(context);
    let lastText: string | undefined;
    const unsubscribe = piSession.subscribe((event) => {
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
