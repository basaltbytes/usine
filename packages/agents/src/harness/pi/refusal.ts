import type { AgentSessionId } from "@usine/core/agent/session";
import { DateTime, Option } from "effect";
import { AgentCapacityError, type AgentResultError, harnessFailure } from "../../runtime.ts";

// Pi's ChatGPT subscription provider states the wait until the limit resets in whole minutes when
// the provider reports a reset time.
const planLimit =
  /\bYou have hit your ChatGPT usage limit\b[^.]*\.(?:\s*Try again in ~(\d+) min\.)?/u;
// Over WebSocket, the same provider relays the backend's error without its reset time.
const streamedPlanLimit = /\bThe usage limit has been reached\b|\busage_limit_reached\b/u;
// Sign in with ChatGPT on the OpenAI provider shares the subscription's usage limit.
const sharedLimit = /\bsubscription_sharing_usage_limit_exceeded\b/u;
const rateLimited = /(?<![\w.])429(?![\w.])/u;
const rateLimitText = /\brate.?limit|\btoo many requests\b|\bresource.?exhausted\b/iu;
// Billing exhaustion also uses HTTP 429 but does not reset.
const billingLimit =
  /\binsufficient_quota\b|\bquota exceeded\b|\bexceeded your current quota\b|\bbilling\b/iu;

/**
 * Classifies the error that ended a Pi turn. A plan usage limit, a shared subscription limit, or
 * an HTTP 429 rate limit is a capacity refusal; a plan limit with a stated wait resets one minute
 * after it, since Pi rounds the wait to the nearest minute.
 */
export const piFailure = (
  sessionId: AgentSessionId,
  turn: { readonly errorMessage: string; readonly timestamp: number },
): AgentCapacityError | AgentResultError => {
  const message = turn.errorMessage;
  const plan = planLimit.exec(message);
  if (plan !== null)
    return AgentCapacityError.make({
      sessionId: Option.some(sessionId),
      message,
      resetsAt: Option.fromUndefinedOr(plan[1]).pipe(
        Option.flatMap((minutes) =>
          DateTime.make(turn.timestamp).pipe(
            Option.map(DateTime.add({ minutes: Number(minutes) + 1 })),
          ),
        ),
      ),
    });
  if (
    streamedPlanLimit.test(message) ||
    sharedLimit.test(message) ||
    (rateLimited.test(message) && rateLimitText.test(message) && !billingLimit.test(message))
  )
    return AgentCapacityError.make({ sessionId: Option.some(sessionId), message });
  return harnessFailure(Option.some(sessionId), message);
};
