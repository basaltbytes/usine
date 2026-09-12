import type { AttemptId } from "@usine/core/attempt";
import { AgentSessionId } from "@usine/core/agent/session";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure, RunawayFailure } from "@usine/core/attempt/failure";
import { Clock, Deferred, Effect, Option, Queue } from "effect";

/** Enforces Attempt ceilings: Holds pause elapsed execution time; reported tokens continue accumulating. */
export const withAttemptGuard = <A>(
  limits: {
    readonly attemptId: AttemptId;
    readonly maxAttemptMinutes: number;
    readonly maxAttemptTokens: number;
  },
  io: AttemptChannel.Sink,
  run: (sink: AttemptChannel.Sink) => Effect.Effect<A, AttemptFailure>,
): Effect.Effect<A, AttemptFailure> =>
  Effect.gen(function* () {
    const ended = new Set<AgentSessionId>();
    const tokens = new Map<AgentSessionId, number>();
    const exhausted = yield* Deferred.make<never, RunawayFailure>();
    const holds = new Set<AgentSessionId>();
    const changes = yield* Queue.make<boolean>();
    const append: AttemptChannel.Sink["append"] = Effect.fn("AttemptGuard.append")(
      function* (direction, envelope) {
        yield* Effect.annotateCurrentSpan({ attemptId: limits.attemptId });
        yield* io.append(direction, envelope);
        if (
          envelope.payload._tag === "SessionEvent" &&
          envelope.payload.event._tag === "SessionTokensUpdated"
        ) {
          const { session, totalTokens } = envelope.payload.event;
          tokens.set(session.id, Math.max(tokens.get(session.id) ?? 0, totalTokens));
          const consumed = [...tokens.values()].reduce((sum, value) => sum + value, 0);
          if (consumed >= limits.maxAttemptTokens) {
            yield* Effect.logWarning("Attempt reached its token limit", {
              attemptId: envelope.attemptId,
              consumed,
              maxAttemptTokens: limits.maxAttemptTokens,
            });
            yield* Deferred.fail(exhausted, new RunawayFailure({ ceiling: "tokens" }));
            // Let the guard interrupt the run host through its cancellation handshake
            // before a following terminal frame can win the race.
            yield* Effect.never;
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
        if (wasHeld !== holds.size > 0) {
          yield* Effect.logInfo("Attempt wall-clock supervision changed", {
            attemptId: envelope.attemptId,
            heldChildren: holds.size,
          });
          yield* Queue.offer(changes, holds.size > 0);
        }
      },
    );
    const guard = Effect.fn("AttemptGuard.watch")(function* () {
      yield* Effect.annotateCurrentSpan({ attemptId: limits.attemptId });
      let remaining = limits.maxAttemptMinutes * 60_000;
      let paused = false;
      while (remaining > 0) {
        if (paused) {
          paused = yield* Queue.take(changes);
          continue;
        }
        const began = yield* Clock.currentTimeMillis;
        const changed = yield* Queue.take(changes).pipe(Effect.timeoutOption(remaining));
        if (Option.isNone(changed)) break;
        remaining -= (yield* Clock.currentTimeMillis) - began;
        paused = changed.value;
      }
      yield* Effect.logWarning("Attempt reached its unsupervised wall-clock limit", {
        attemptId: limits.attemptId,
        maxAttemptMinutes: limits.maxAttemptMinutes,
      });
      return yield* new RunawayFailure({ ceiling: "wall-clock" });
    });
    return yield* Effect.raceFirst(
      run({ append }),
      Effect.raceFirst(guard(), Deferred.await(exhausted)),
    );
  });
