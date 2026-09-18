import type { AttemptId } from "@usine/core/attempt";
import { AgentSessionId } from "@usine/core/agent/session";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, RunawayFailure } from "@usine/core/attempt/failure";
import { Clock, Effect, Option, Queue } from "effect";

/** The share of a ceiling at which the guard warns the parent session once, before tripping. */
const WARNING_FRACTION = 0.8;

export interface AttemptGuardLimits {
  readonly attemptId: AttemptId;
  /** Wall-clock ceiling in minutes; none leaves the timer unarmed. */
  readonly maxAttemptMinutes: Option.Option<number>;
  /** Consumed-token ceiling across the parent and every child; none leaves the meter unchecked. */
  readonly maxAttemptTokens: Option.Option<number>;
  /** Delivers the warning steer to the parent session; failures are logged and never fail the Attempt. */
  readonly warn: (message: string) => Effect.Effect<void, AttemptFailure>;
}

/**
 * Enforces the Attempt ceilings that are configured: Holds pause elapsed
 * execution time; reported tokens continue accumulating. Each armed ceiling
 * sends the parent one warning steer at `WARNING_FRACTION` of its limit.
 */
export const withAttemptGuard = <A>(
  limits: AttemptGuardLimits,
  io: AttemptChannel.Sink,
  run: (sink: AttemptChannel.Sink) => Effect.Effect<A, AttemptFailure>,
): Effect.Effect<A, AttemptFailure> =>
  Effect.gen(function* () {
    const ended = new Set<AgentSessionId>();
    const tokens = new Map<AgentSessionId, number>();
    const holds = new Set<AgentSessionId>();
    const changes = yield* Queue.make<boolean>();
    let warnedTokens = false;
    const warn = (ceiling: "tokens" | "wall-clock", message: string) =>
      Effect.logInfo("Warning the Attempt before its ceiling", {
        attemptId: limits.attemptId,
        ceiling,
      }).pipe(
        Effect.andThen(limits.warn(message)),
        Effect.tapError((error) =>
          Effect.logWarning("Attempt ceiling warning was not delivered", {
            attemptId: limits.attemptId,
            ceiling,
            errorTag: error._tag,
          }),
        ),
        Effect.ignore,
      );
    const append: AttemptChannel.Sink["append"] = Effect.fn("AttemptGuard.append")(
      function* (direction, envelope) {
        yield* Effect.annotateCurrentSpan({ attemptId: limits.attemptId });
        yield* io.append(direction, envelope);
        if (
          envelope.payload._tag === "SessionEvent" &&
          envelope.payload.event._tag === "SessionTokensUpdated" &&
          Option.isSome(limits.maxAttemptTokens)
        ) {
          const maxAttemptTokens = limits.maxAttemptTokens.value;
          const { session, totalTokens } = envelope.payload.event;
          tokens.set(session.id, Math.max(tokens.get(session.id) ?? 0, totalTokens));
          const consumed = [...tokens.values()].reduce((sum, value) => sum + value, 0);
          if (consumed >= maxAttemptTokens) {
            yield* Effect.logWarning("Attempt reached its token limit", {
              attemptId: envelope.attemptId,
              consumed,
              maxAttemptTokens,
            });
            return yield* new RunawayFailure({ ceiling: "tokens" });
          }
          if (!warnedTokens && consumed >= maxAttemptTokens * WARNING_FRACTION) {
            warnedTokens = true;
            yield* warn(
              "tokens",
              `${consumed} of ${maxAttemptTokens} tokens used by this Attempt; commit and push your work now.`,
            );
          }
        }
        const wasHeld = holds.size > 0;
        const payload = envelope.payload;
        if (
          payload._tag === "InterventionApplied" &&
          payload.intervention.target._tag === "Child"
        ) {
          const id = payload.intervention.target.sessionId;
          if (payload.state.held && !ended.has(id)) holds.add(id);
          else holds.delete(id);
        }
        if (payload._tag === "SessionEvent" && payload.event._tag === "SessionFinished") {
          ended.add(payload.event.session.id);
          holds.delete(payload.event.session.id);
        }
        const isHeld = holds.size > 0;
        if (wasHeld !== isHeld) {
          yield* Effect.logInfo("Attempt wall-clock supervision changed", {
            attemptId: envelope.attemptId,
            heldChildren: holds.size,
          });
          yield* Queue.offer(changes, isHeld);
        }
      },
    );
    const guard = Effect.fn("AttemptGuard.watch")(function* (maxAttemptMinutes: number) {
      yield* Effect.annotateCurrentSpan({ attemptId: limits.attemptId });
      const budget = maxAttemptMinutes * 60_000;
      let remaining = budget;
      let warned = false;
      let paused = false;
      while (remaining > 0) {
        if (paused) {
          paused = yield* Queue.take(changes);
          continue;
        }
        // Wait only until the warning point first, so the warning fires at the
        // fraction of unsupervised time rather than at the end of the budget.
        const wait = warned ? remaining : remaining - budget * (1 - WARNING_FRACTION);
        const began = yield* Clock.currentTimeMillis;
        const changed = yield* Queue.take(changes).pipe(Effect.timeoutOption(wait));
        remaining -= (yield* Clock.currentTimeMillis) - began;
        if (Option.isSome(changed)) {
          paused = changed.value;
          continue;
        }
        if (warned) break;
        warned = true;
        const usedMinutes = Math.round((budget - remaining) / 6_000) / 10;
        yield* warn(
          "wall-clock",
          `${usedMinutes} of ${maxAttemptMinutes} minutes used by this Attempt; commit and push your work now.`,
        );
      }
      yield* Effect.logWarning("Attempt reached its unsupervised wall-clock limit", {
        attemptId: limits.attemptId,
        maxAttemptMinutes,
      });
      return yield* new RunawayFailure({ ceiling: "wall-clock" });
    });
    if (Option.isNone(limits.maxAttemptMinutes) && Option.isNone(limits.maxAttemptTokens)) {
      yield* Effect.logDebug("Attempt runs without runaway ceilings", {
        attemptId: limits.attemptId,
      });
    }
    return yield* Option.match(limits.maxAttemptMinutes, {
      onNone: () => run({ append, salvage: io.salvage }),
      onSome: (minutes) => Effect.raceFirst(run({ append, salvage: io.salvage }), guard(minutes)),
    });
  });
