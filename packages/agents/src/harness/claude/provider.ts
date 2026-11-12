import type { AgentSessionId } from "@usine/core/agent/session";
import { type DateTime, Option, Schema } from "effect";
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
import { isRateLimitEvent, rejectedUntil } from "./rate-limits.ts";

/** What one Claude message reported about its provider. */
export interface ProviderReport {
  /** The provider retry that the message reports. */
  readonly retry: Option.Option<typeof ClaudeApiRetry.Type>;
  /** The reset time of the usage limit, when the message reports that the limit rejects requests. */
  readonly rejectedUntil: Option.Option<DateTime.Utc>;
}

/**
 * Tracks what a Claude turn's messages report about its provider, and classifies the turn's
 * failed result with it. A session and a completion read each message through `read`, so both
 * fail a result the same way. A capacity refusal while the latest rate-limit report rejects
 * requests carries the limit's reset time.
 */
export const claudeProviderFailures = (sessionId: AgentSessionId) => {
  let failure = Option.none<AgentCapacityError | AgentResultError>();
  let limitResetsAt = Option.none<DateTime.Utc>();
  const withReset = (refusal: AgentCapacityError): AgentCapacityError =>
    Option.isSome(limitResetsAt)
      ? AgentCapacityError.make({
          sessionId: refusal.sessionId,
          message: refusal.message,
          resetsAt: limitResetsAt,
        })
      : refusal;
  return {
    /** Records what `message` reports: a provider retry, an assistant error, or a rate limit. */
    read: (message: Schema.Json): ProviderReport => {
      const rejected = isRateLimitEvent(message) ? rejectedUntil(message) : Option.none();
      if (isRateLimitEvent(message)) limitResetsAt = rejected;
      const retry = decodeApiRetry(message);
      if (Option.isSome(retry)) failure = apiRetryFailure(sessionId, retry.value);
      else if (isAssistantMessage(message)) failure = assistantFailure(sessionId, message, failure);
      return { retry, rejectedUntil: rejected };
    },
    /** Returns the failure of a result that isn't a `success`, or that has no result text. */
    failedResult: (
      result: typeof ClaudeResultMessage.Type,
    ): AgentCapacityError | AgentResultError => {
      const failed = resultFailure(sessionId, result, failure);
      return Schema.is(AgentCapacityError)(failed) ? withReset(failed) : failed;
    },
    /** Returns the capacity refusal or usage limit of a `success` result with `is_error`. */
    refusal: (result: typeof ClaudeResultMessage.Type): Option.Option<AgentCapacityError> =>
      Option.map(apiErrorRefusal(sessionId, result, failure), withReset),
    /** Forgets the reported failure, after a turn that succeeded. */
    clear: () => {
      failure = Option.none();
    },
  };
};
export type ClaudeProviderFailures = ReturnType<typeof claudeProviderFailures>;
