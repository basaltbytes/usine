import type { ContinuationPolicy } from "../continuation.ts";
import type { OperatorMessageId } from "@usine/core/attempt/channel";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@usine/core/agent/session";
import { Effect, Fiber, Option, Schema } from "effect";
import {
  AgentCapacityError,
  type AgentSessionError,
  harnessFailure,
  type RunningSession,
  type QueuedOperatorMessage,
  type InterruptedTool,
} from "../../runtime.ts";
import { sessionConversation } from "../conversation.ts";
import type { PiSession } from "./sdk.ts";
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

/** Runs successive Pi turns in one SDK session; the conversation decides when the session completes. */
export const piTurns = Effect.fn("PiTurns.start")(function* (options: {
  readonly session: AgentSession;
  readonly held: boolean;
  readonly paused: boolean;
  readonly idle: Option.Option<string>;
  readonly unread: ReadonlyArray<QueuedOperatorMessage>;
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
            if (
              lastAssistant?.stopReason === "error" &&
              lastAssistant.errorMessage !== undefined &&
              lastAssistant.errorMessage !== ""
            ) {
              const failure = harnessFailure(
                Option.some(options.session.id),
                lastAssistant.errorMessage,
              );
              if (Schema.is(AgentCapacityError)(failure)) return Effect.fail(failure);
            }
            return conversation.finish(
              options.lastText() ??
                lastPiMessageText(options.sdk.messages) ??
                "Pi session completed",
            );
          }),
          Effect.catch(options.channel.fail),
          Effect.forkIn(scope),
          Effect.asVoid,
        ),
      ),
    );
  // Pi delivers a steering message after the running tool calls return, before its next model request.
  const pending: Array<QueuedOperatorMessage> = [];
  const queueSteer = (message: string, id?: OperatorMessageId) =>
    Effect.gen(function* () {
      const input = id === undefined ? undefined : { id, message };
      if (input !== undefined) pending.push(input);
      const remove = Effect.sync(() => {
        if (input === undefined) return;
        const index = pending.indexOf(input);
        if (index >= 0) pending.splice(index, 1);
      });
      const disposition = yield* Effect.tryPromise({
        try: () => options.sdk.steer(message),
        catch: (cause) => options.error("steer", cause),
      }).pipe(Effect.onError(() => remove));
      if (disposition === "handled") yield* remove;
      return disposition === "handled" ? ("read" as const) : ("queued" as const);
    });
  const conversation = yield* sessionConversation({
    session: options.session,
    channel: options.channel,
    held: options.held,
    paused: options.paused,
    idle: options.idle,
    unread: options.unread,
    send: (message, activity, id) =>
      activity === "idle" || !launched
        ? startTurn(message).pipe(Effect.as("read" as const))
        : queueSteer(message, id),
    pause: Effect.void,
    beforeFinish: Effect.void,
  });
  // Pi removes a steering message from its queue when the message starts in the conversation.
  const observed = new WeakSet<object>();
  const unsubscribe = options.sdk.subscribe((event) => {
    if (event.type !== "message_start") return;
    if (observed.has(event.message)) return;
    observed.add(event.message);
    const text = piUserMessageText(event.message);
    if (Option.isNone(text)) return;
    const index = pending.findIndex((message) => message.message === text.value);
    if (index < 0) return;
    const [message] = pending.splice(index, 1);
    if (message !== undefined) Effect.runForkWith(context)(conversation.read([message.id]));
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  options.gate.set(conversation.awaitUnpaused);
  if (!options.paused && Option.isNone(options.idle) && Option.isSome(options.prompt))
    yield* startTurn(options.prompt.value);
  const steer = (message: string, id?: OperatorMessageId) =>
    launched ? queueSteer(message, id).pipe(Effect.asVoid) : startTurn(message);
  return {
    recover: (tools: ReadonlyArray<InterruptedTool>) =>
      conversation.recover(options.policy, tools, steer),
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
