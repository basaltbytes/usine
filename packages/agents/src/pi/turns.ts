import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { ChildSession } from "@usine/core/agent/session";
import { Effect, Fiber, Option } from "effect";
import {
  AgentCapacityError,
  type AgentSessionError,
  harnessFailure,
  type RunningSession,
} from "../runtime.ts";
import { type MessageTaken, sessionConversation } from "./conversation.ts";
import type { PiSession } from "./sdk.ts";
import { lastPiMessageText, piUserMessageText, type SessionChannel } from "./session.ts";

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

/** Runs successive Pi turns in one SDK session; the conversation decides when the session completes. */
export const piTurns = Effect.fn("PiTurns.start")(function* (options: {
  readonly session: ChildSession;
  readonly sdk: PiSession;
  readonly channel: SessionChannel;
  readonly prompt: string;
  readonly lastText: () => string | undefined;
  readonly error: (
    operation: "stream" | "steer" | "interrupt",
    cause: unknown,
  ) => AgentSessionError;
  readonly gate: Effect.Success<typeof piPauseGate>;
}) {
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<never>();
  const startTurn = (message: string): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () => options.sdk.prompt(message),
      catch: (cause) => options.error("stream", cause),
    }).pipe(
      Effect.flatMap(() => {
        const lastAssistant = [...options.sdk.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (lastAssistant?.stopReason === "error" && lastAssistant.errorMessage) {
          const failure = harnessFailure(
            Option.some(options.session.id),
            lastAssistant.errorMessage,
          );
          if (failure instanceof AgentCapacityError) return Effect.fail(failure);
        }
        return conversation.finish(
          options.lastText() ?? lastPiMessageText(options.sdk.messages) ?? "Pi session completed",
        );
      }),
      Effect.catch(options.channel.fail),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  // Pi delivers a steering message after the running tool calls return, before its next model request.
  const queueSteer = (message: string) =>
    Effect.tryPromise({
      try: () => options.sdk.steer(message),
      catch: (cause) => options.error("steer", cause),
    }).pipe(
      Effect.map((disposition): MessageTaken => (disposition === "handled" ? "read" : "queued")),
    );
  const conversation = yield* sessionConversation({
    session: options.session,
    channel: options.channel,
    send: (message, activity) =>
      activity === "idle"
        ? startTurn(message).pipe(Effect.as("read" as const))
        : queueSteer(message),
    pause: Effect.void,
    beforeFinish: Effect.void,
  });
  // Pi removes a steering message from its queue when the message starts in the conversation.
  const unsubscribe = options.sdk.subscribe((event) => {
    if (event.type !== "message_start") return;
    const text = piUserMessageText(event.message);
    if (Option.isSome(text))
      Effect.runForkWith(context)(conversation.read((queued) => queued.indexOf(text.value) + 1));
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  options.gate.set(conversation.awaitUnpaused);
  yield* startTurn(options.prompt);
  return {
    intervene: conversation.intervene,
    steer: (message: string) => queueSteer(message).pipe(Effect.asVoid),
    interrupt: Effect.tryPromise({
      try: () => options.sdk.abort(),
      catch: (cause) => options.error("interrupt", cause),
    }),
  } satisfies Pick<RunningSession, "intervene" | "steer" | "interrupt">;
});
