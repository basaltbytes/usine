import {
  type AgentSession,
  type PoolRateLimitsUpdated,
  type RateLimitWindow,
  usedUpUntil,
} from "@usine/core/agent/session";
import { type DateTime, Effect, Option, Schema } from "effect";
import { AgentCapacityError, type AgentResultError } from "../../runtime.ts";
import {
  apiErrorRefusal,
  apiRetryFailure,
  assistantFailure,
  type ClaudeApiRetry,
  type ClaudeResultMessage,
  decodeApiRetry,
  isAssistantMessage,
  resultFailure,
} from "./codec.ts";
import {
  type AllowanceType,
  claudeRateLimits,
  isRateLimitEvent,
  rejectedUntil,
  usageCredits,
} from "./rate-limits.ts";

/** Why a turn stops on its first request on usage credits, as Needs attention shows it. */
const USAGE_CREDITS_MESSAGE =
  "Claude Code started billing usage credits after the plan's usage limit; settings.allow_usage_credits is off, so the child stopped";

/** What one Claude message reported about its provider. */
export interface ProviderReport {
  /** The provider retry that the message reports. */
  readonly retry: Option.Option<typeof ClaudeApiRetry.Type>;
  /** The reset time of the usage limit, when the message reports that the limit rejects requests. */
  readonly rejectedUntil: Option.Option<DateTime.Utc>;
  /** The Claude plan allowance window that the message reports, as a pool update. */
  readonly rateLimits: Option.Option<PoolRateLimitsUpdated>;
  /**
   * The capacity refusal that stops the turn, when the message reports that a request ran on usage
   * credits. It resets with the plan window that the message names, or else with the latest window
   * that the session's reports show used up.
   */
  readonly usageCredits: Option.Option<AgentCapacityError>;
}

/**
 * Tracks what a Claude turn's messages report about its provider, and classifies the turn's
 * failed result with it. A session and a completion read each message through `read`, so both
 * fail a result the same way. A capacity refusal while the latest rate-limit report rejects
 * requests carries the limit's reset time. Without one, it carries the reset time that
 * `usedUpUntil` reads from the latest window of each allowance that the session's reports show.
 * A report of a request on usage credits yields a capacity refusal with the plan's reset time.
 */
export const claudeProviderFailures = (session: AgentSession) => {
  const readRateLimits = claudeRateLimits(session);
  let failure = Option.none<AgentCapacityError | AgentResultError>();
  let limitResetsAt = Option.none<DateTime.Utc>();
  const windows = new Map<AllowanceType, RateLimitWindow>();
  const withReset = (refusal: AgentCapacityError): AgentCapacityError => {
    const resetsAt = Option.orElse(limitResetsAt, () => usedUpUntil(windows.values()));
    return Option.isSome(resetsAt)
      ? AgentCapacityError.make({
          sessionId: refusal.sessionId,
          message: refusal.message,
          resetsAt,
        })
      : refusal;
  };
  return {
    /** Records what `message` reports: a provider retry, an assistant error, or a rate limit. */
    read: (message: Schema.Json): Effect.Effect<ProviderReport> =>
      Effect.map(readRateLimits(message), (reported) => {
        if (Option.isSome(reported)) windows.set(reported.value.allowance, reported.value.window);
        const rejected = isRateLimitEvent(message) ? rejectedUntil(message) : Option.none();
        if (isRateLimitEvent(message)) limitResetsAt = rejected;
        const credits = isRateLimitEvent(message) ? usageCredits(message) : Option.none();
        const retry = decodeApiRetry(message);
        if (Option.isSome(retry)) failure = apiRetryFailure(session.id, retry.value);
        else if (isAssistantMessage(message))
          failure = assistantFailure(session.id, message, failure);
        return {
          retry,
          rejectedUntil: rejected,
          rateLimits: Option.map(reported, ({ update }) => update),
          usageCredits: Option.map(credits, ({ planResetsAt }) =>
            AgentCapacityError.make({
              sessionId: Option.some(session.id),
              message: USAGE_CREDITS_MESSAGE,
              resetsAt: Option.orElse(planResetsAt, () => usedUpUntil(windows.values())),
            }),
          ),
        };
      }),
    /** Returns the failure of a result that isn't a `success`, or that has no result text. */
    failedResult: (
      result: typeof ClaudeResultMessage.Type,
    ): AgentCapacityError | AgentResultError => {
      const failed = resultFailure(session.id, result, failure);
      return Schema.is(AgentCapacityError)(failed) ? withReset(failed) : failed;
    },
    /** Returns the capacity refusal or usage limit of a `success` result with `is_error`. */
    refusal: (result: typeof ClaudeResultMessage.Type): Option.Option<AgentCapacityError> =>
      Option.map(apiErrorRefusal(session.id, result, failure), withReset),
    /** Forgets the reported failure, after a turn that succeeded. */
    clear: () => {
      failure = Option.none();
    },
  };
};
export type ClaudeProviderFailures = ReturnType<typeof claudeProviderFailures>;
