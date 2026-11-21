import type { ContinuationPolicy } from "../continuation.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@usine/core/agent/session";
import { Effect, Fiber, Option, Schema } from "effect";
import {
  AgentCapacityError,
  type AgentSessionError,
  type RunningSession,
  type InterruptedTool,
} from "../../runtime.ts";
import { sessionConversation } from "../conversation.ts";
import { failedPiTurn } from "./refusal.ts";
import type { PiMessage, PiSession } from "./sdk.ts";
import { Receipt } from "../receipts.ts";
import { lastPiMessageText, piUserMessageText, type SessionChannel } from "../session.ts";

/** Creates a gate that blocks Pi tool calls and provider requests at their next boundary while an operator pause is active. */
export const piPauseGate = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const scope = yield* Effect.scope;
  let boundary = Effect.void;
  const wait = () =>
    Effect.runPromiseWith(context)(
      Effect.suspend(() => boundary).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    );
  return {
    set: (next: Effect.Effect<void>) => {
      boundary = next;
    },
    extension: {
      name: "usine-session-intervention",
      factory: (pi) => {
        pi.on("tool_call", wait);
        pi.on("before_provider_request", wait);
      },
    } satisfies InlineExtension,
  };
});

/** A message that started in a Pi conversation, and the session's tool-call count at its start. */
export interface PiMessageStart {
  readonly message: PiMessage;
  readonly toolCalls: number;
}

/**
 * Decodes what a Pi message start says about the operator messages that the session read. Pi
 * starts a queued steering message in the conversation, with the message's text, when it reads
 * it.
 */
export const piReceipts = ({ message, toolCalls }: PiMessageStart): ReadonlyArray<Receipt> =>
  Option.match(piUserMessageText(message), {
    onNone: () => [],
    onSome: (text) => [Receipt.ByText({ text, at: toolCalls, item: Option.none() })],
  });

/** Runs successive Pi turns in one SDK session; the conversation decides when the session completes. */
export const piTurns = Effect.fn("PiTurns.start")(function* (options: {
  readonly session: AgentSession;
  readonly sdk: PiSession;
  readonly channel: SessionChannel;
  readonly prompt: Option.Option<string>;
  readonly policy: ContinuationPolicy;
  readonly lastText: () => string | undefined;
  readonly error: (
    operation: "stream" | "steer" | "interrupt",
    cause: unknown,
  ) => AgentSessionError;
  readonly gate: Effect.Success<typeof piPauseGate>;
}) {
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<never>();
  let launched = Option.isSome(options.prompt);
  const startTurn = (message: string): Effect.Effect<void> =>
    Effect.sync(() => {
      launched = true;
    }).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => options.sdk.prompt(message),
          catch: (cause) => options.error("stream", cause),
        }).pipe(
          Effect.flatMap(() => {
            const lastAssistant = [...options.sdk.messages]
              .reverse()
              .find((message) => message.role === "assistant");
            const finish = conversation.finish(
              options.lastText() ??
                lastPiMessageText(options.sdk.messages) ??
                "Pi session completed",
            );
            if (
              lastAssistant?.stopReason === "error" &&
              lastAssistant.errorMessage !== undefined &&
              lastAssistant.errorMessage !== ""
            )
              return failedPiTurn(options.session.id, {
                errorMessage: lastAssistant.errorMessage,
                timestamp: lastAssistant.timestamp,
              }).pipe(
                Effect.flatMap((failure) =>
                  Schema.is(AgentCapacityError)(failure) ? Effect.fail(failure) : finish,
                ),
              );
            return finish;
          }),
          Effect.catch(options.channel.fail),
          Effect.forkIn(scope),
          Effect.asVoid,
        ),
      ),
    );
  // Pi delivers a steering message after the running tool calls return, before its next model
  // request, unless an input hook handles it at once.
  const queueSteer = (message: string) =>
    Effect.tryPromise({
      try: () => options.sdk.steer(message),
      catch: (cause) => options.error("steer", cause),
    }).pipe(
      Effect.map((disposition) =>
        disposition === "handled" ? ("read" as const) : ("queued" as const),
      ),
    );
  const conversation = yield* sessionConversation({
    session: options.session,
    channel: options.channel,
    policy: options.policy,
    decode: piReceipts,
    send: (message, activity) =>
      activity === "idle" || !launched
        ? startTurn(message).pipe(Effect.as("read" as const))
        : queueSteer(message),
    pause: Effect.void,
    beforeFinish: Effect.void,
  });
  /** Records once that Pi saved a user message, which its conversation file then holds. */
  const recordPrompt = yield* Effect.cached(
    options.policy.journal.prompted.pipe(
      Effect.tap(() =>
        Effect.logDebug("Pi saved the child's first user message", {
          sessionId: options.session.id,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not record the Pi prompt receipt", {
          sessionId: options.session.id,
          message: error.message,
        }),
      ),
    ),
  );
  // Pi can report a message start twice; each message object counts once.
  const observed = new WeakSet<object>();
  const unsubscribe = options.sdk.subscribe((event) => {
    // Pi appends a message to its conversation file after its listeners see `message_end`.
    if (event.type === "message_end" && Option.isSome(piUserMessageText(event.message)))
      Effect.runForkWith(context)(recordPrompt);
    if (event.type !== "message_start") return;
    if (observed.has(event.message)) return;
    observed.add(event.message);
    // The read is forked, so the tool count is taken now: a tool call that Pi starts next is
    // queued before the forked read runs.
    Effect.runForkWith(context)(
      conversation.observe({
        message: event.message,
        toolCalls: options.channel.toolCallsUnsafe(),
      }),
    );
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  options.gate.set(conversation.awaitUnpaused);
  const { restored } = options.policy;
  if (!restored.paused && Option.isNone(restored.idle) && Option.isSome(options.prompt))
    yield* startTurn(options.prompt.value);
  const send = (message: string) =>
    launched ? queueSteer(message) : startTurn(message).pipe(Effect.as("read" as const));
  const steer = (message: string) => send(message).pipe(Effect.asVoid);
  return {
    recover: (tools: ReadonlyArray<InterruptedTool>) => conversation.recover(tools, send),
    intervene: conversation.intervene,
    steer,
    interrupt: Effect.tryPromise({
      try: () => options.sdk.abort(),
      catch: (cause) => options.error("interrupt", cause),
    }),
  } satisfies Pick<RunningSession, "intervene" | "steer" | "interrupt"> & {
    readonly recover: (
      tools: ReadonlyArray<InterruptedTool>,
    ) => Effect.Effect<void, AgentSessionError>;
  };
});
