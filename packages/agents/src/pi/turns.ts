import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { ChildSession } from "@usine/core/agent/session";
import { Effect, Fiber } from "effect";
import { type AgentSessionError, type RunningSession } from "../runtime.ts";
import { sessionConversation } from "./conversation.ts";
import type { PiSession } from "./sdk.ts";
import { lastPiMessageText, type SessionChannel } from "./session.ts";

/** Holds Pi tool calls and provider requests at their next boundary while an operator pause lasts. */
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

/** Runs successive Pi turns in one SDK session while the conversation owns completion. */
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
  const startTurn = (message: string): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () => options.sdk.prompt(message),
      catch: (cause) => options.error("stream", cause),
    }).pipe(
      Effect.flatMap(() =>
        conversation.finish(
          options.lastText() ?? lastPiMessageText(options.sdk.messages) ?? "Pi session completed",
        ),
      ),
      Effect.catch(options.channel.fail),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  const steer = (message: string) =>
    Effect.tryPromise({
      try: () => options.sdk.steer(message),
      catch: (cause) => options.error("steer", cause),
    }).pipe(Effect.asVoid);
  const conversation = yield* sessionConversation({
    session: options.session,
    channel: options.channel,
    send: (message, activity) => (activity === "idle" ? startTurn(message) : steer(message)),
    pause: Effect.void,
    beforeFinish: Effect.void,
  });
  options.gate.set(conversation.awaitUnpaused);
  yield* startTurn(options.prompt);
  return {
    intervene: conversation.intervene,
    steer,
    interrupt: Effect.tryPromise({
      try: () => options.sdk.abort(),
      catch: (cause) => options.error("interrupt", cause),
    }),
  } satisfies Pick<RunningSession, "intervene" | "steer" | "interrupt">;
});
