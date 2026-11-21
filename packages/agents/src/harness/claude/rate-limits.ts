import {
  type AgentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow,
  sessionPool,
} from "@usine/core/agent/session";
import { DateTime, Effect, Option, Schema } from "effect";

/** Returns whether `message` is Claude Code's report of the account's rate-limit state. */
export const isRateLimitEvent = Schema.is(
  Schema.Struct({ type: Schema.Literal("rate_limit_event") }),
);
const AllowanceType = Schema.Literals([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
]);
export type AllowanceType = typeof AllowanceType.Type;
const ClaudeRateLimit = Schema.Struct({
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
    isUsingOverage: Schema.optionalKey(Schema.Boolean),
    overageInUse: Schema.optionalKey(Schema.Boolean),
  }),
});
const decodeRateLimit = Schema.decodeUnknownEffect(ClaudeRateLimit);
const decodeRateLimitOption = Schema.decodeUnknownOption(ClaudeRateLimit);

/** The allowance window that one Claude plan rate-limit report shows. */
export interface AllowanceReport {
  readonly allowance: AllowanceType;
  readonly window: RateLimitWindow;
  /** The pool update that reports only this window. */
  readonly update: PoolRateLimitsUpdated;
}

/**
 * Reads the allowance window that a Claude plan's rate-limit report shows. Returns `None` for
 * other messages, an API-key session, and a report without a supported allowance's utilization.
 */
export const claudeRateLimits = (session: AgentSession) => {
  const pool = sessionPool(session);

  return Effect.fn("ClaudeRateLimits.read")(
    function* (message: Schema.Json) {
      yield* Effect.annotateCurrentSpan({ sessionId: session.id, pool });
      if (!isRateLimitEvent(message)) return Option.none<AllowanceReport>();
      if (pool !== "claudePlan") {
        yield* Effect.logDebug("Skipping Claude plan windows for an API-key session", {
          sessionId: session.id,
          pool,
        });
        return Option.none<AllowanceReport>();
      }
      const { rate_limit_info: info } = yield* decodeRateLimit(message);
      if (!Schema.is(AllowanceType)(info.rateLimitType) || info.utilization === undefined) {
        yield* Effect.logDebug("Claude rate-limit report has no supported allowance utilization", {
          sessionId: session.id,
          rateLimitType: info.rateLimitType,
          status: info.status,
        });
        return Option.none<AllowanceReport>();
      }
      const field = info.rateLimitType === "five_hour" ? "primary" : "secondary";
      const window = RateLimitWindow.make({
        usedPercent: info.utilization * 100,
        windowDurationMinutes: Option.some(field === "primary" ? 300 : 10_080),
        resetsAt: Option.fromUndefinedOr(info.resetsAt).pipe(Option.map(DateTime.fromEpochSeconds)),
      });
      const snapshot = RateLimitsSnapshot.make({
        limitId: Option.none(),
        limitName: Option.none(),
        primary: field === "primary" ? Option.some(window) : Option.none(),
        secondary: field === "secondary" ? Option.some(window) : Option.none(),
      });
      yield* Effect.logDebug("Claude plan rate-limit window updated", {
        sessionId: session.id,
        rateLimitType: info.rateLimitType,
        window: field,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      });
      return Option.some<AllowanceReport>({
        allowance: info.rateLimitType,
        window,
        update: PoolRateLimitsUpdated.make({ session, pool, rateLimits: snapshot }),
      });
    },
    Effect.catchTag("SchemaError", () =>
      Effect.logWarning("Skipping an invalid Claude rate-limit report", {
        sessionId: session.id,
        pool,
      }).pipe(Effect.as(Option.none<AllowanceReport>())),
    ),
  );
};

/**
 * Returns the reset time of the usage limit that a rate-limit report rejects requests under, or
 * `None` if the report allows requests, has no reset time, or doesn't decode.
 */
export const rejectedUntil = (message: Schema.Json): Option.Option<DateTime.Utc> =>
  decodeRateLimitOption(message).pipe(
    Option.filter(({ rate_limit_info: info }) => info.status === "rejected"),
    Option.flatMap(({ rate_limit_info: info }) => Option.fromUndefinedOr(info.resetsAt)),
    Option.map(DateTime.fromEpochSeconds),
  );

/** A rate-limit report that says its request ran on usage credits. */
export interface UsageCreditsReport {
  /**
   * The reset time of the plan window that the report names, or `None` for a report without one or
   * on the `overage` limit, whose reset is the credits' own.
   */
  readonly planResetsAt: Option.Option<DateTime.Utc>;
}

/**
 * Reads whether a rate-limit report says that its request ran on usage credits: `isUsingOverage`
 * or `overageInUse`. Returns `None` for a request on plan limits, including a report on the
 * `overage` limit without either flag, and for a report that doesn't decode.
 */
export const usageCredits = (message: Schema.Json): Option.Option<UsageCreditsReport> =>
  decodeRateLimitOption(message).pipe(
    Option.map(({ rate_limit_info: info }) => info),
    Option.filter((info) => info.isUsingOverage === true || info.overageInUse === true),
    Option.map((info) => ({
      planResetsAt:
        info.rateLimitType === "overage"
          ? Option.none()
          : Option.map(Option.fromUndefinedOr(info.resetsAt), DateTime.fromEpochSeconds),
    })),
  );
