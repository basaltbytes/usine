import {
  type ChildSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow,
  sessionPool,
} from "@usine/core/agent/session";
import { DateTime, Effect, Option, Schema } from "effect";

const isRateLimitEvent = Schema.is(Schema.Struct({ type: Schema.Literal("rate_limit_event") }));
const AllowanceType = Schema.Literals([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
]);
const decodeRateLimit = Schema.decodeUnknownEffect(
  Schema.Struct({
    rate_limit_info: Schema.Struct({
      status: Schema.Literals(["allowed", "allowed_warning", "rejected"]),
      rateLimitType: Schema.optionalKey(Schema.String),
      utilization: Schema.optionalKey(
        Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_VALUE / 100 })),
      ),
      // Epoch seconds within JavaScript's supported date range.
      resetsAt: Schema.optionalKey(
        Schema.Int.check(
          Schema.isBetween({ minimum: -8_640_000_000_000, maximum: 8_640_000_000_000 }),
        ),
      ),
    }),
  }),
);

/** Retains the other allowance when Claude reports only one window, including across resumes. */
export const claudeRateLimits = (session: ChildSession) => {
  const pool = sessionPool(session);
  let snapshot = RateLimitsSnapshot.make({
    limitId: Option.none(),
    limitName: Option.none(),
    primary: Option.none(),
    secondary: Option.none(),
  });

  return Effect.fn("ClaudeRateLimits.read")(
    function* (message: Schema.Json) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id, pool });
      if (!isRateLimitEvent(message)) return Option.none<PoolRateLimitsUpdated>();
      if (pool !== "claudePlan") {
        yield* Effect.logDebug("Skipping Claude plan windows for an API-key session", {
          sessionId: session.id,
          pool,
        });
        return Option.none<PoolRateLimitsUpdated>();
      }
      const { rate_limit_info: info } = yield* decodeRateLimit(message);
      if (!Schema.is(AllowanceType)(info.rateLimitType) || info.utilization === undefined) {
        yield* Effect.logDebug("Claude rate-limit report has no supported allowance utilization", {
          sessionId: session.id,
          rateLimitType: info.rateLimitType,
          status: info.status,
        });
        return Option.none<PoolRateLimitsUpdated>();
      }
      const field = info.rateLimitType === "five_hour" ? "primary" : "secondary";
      const window = RateLimitWindow.make({
        usedPercent: info.utilization * 100,
        windowDurationMinutes: Option.some(field === "primary" ? 300 : 10_080),
        resetsAt: Option.fromUndefinedOr(info.resetsAt).pipe(Option.map(DateTime.fromEpochSeconds)),
      });
      snapshot = RateLimitsSnapshot.make({ ...snapshot, [field]: Option.some(window) });
      yield* Effect.logDebug("Claude plan rate-limit window updated", {
        sessionId: session.id,
        rateLimitType: info.rateLimitType,
        window: field,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      });
      return Option.some(PoolRateLimitsUpdated.make({ session, pool, rateLimits: snapshot }));
    },
    Effect.catchTag("SchemaError", () =>
      Effect.logWarning("Skipping an invalid Claude rate-limit report", {
        sessionId: session.id,
        pool,
      }).pipe(Effect.as(Option.none<PoolRateLimitsUpdated>())),
    ),
  );
};
