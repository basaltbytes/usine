import type { AgentSession, AgentSessionId } from "@usine/core/agent/session";
import { SessionTokensUpdated, TokenCount } from "@usine/core/agent/session";
import {
  type Cause,
  type DateTime,
  Effect,
  Option,
  type Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import { AgentCapacityError, AgentResultError, SessionOperationError } from "../../runtime.ts";
import { type CompletionJson, failedCompletion } from "../completion.ts";
import { CompletionInvalid, CompletionRefused, type SessionSpec } from "../contract.ts";
import { claudeTokenMeter } from "../usage.ts";
import {
  apiErrorRefusal,
  apiRetryFailure,
  apiRetryMessage,
  assistantFailure,
  ClaudeResultMessage,
  decodeApiRetry,
  isAssistantMessage,
  resultFailure,
} from "./codec.ts";
import { isRateLimitEvent, rejectedUntil } from "./rate-limits.ts";

/**
 * Returns the value of a structured completion's result, or why it has none: Claude Code found no
 * value that matches the schema within its retries, the model declined, the provider refused for
 * capacity, or the turn failed.
 */
const completionOutcome = (
  sessionId: AgentSessionId,
  result: typeof ClaudeResultMessage.Type,
  providerFailure: Option.Option<AgentCapacityError | AgentResultError>,
): Result.Result<
  Schema.Json,
  CompletionInvalid | CompletionRefused | AgentCapacityError | AgentResultError
> => {
  if (result.subtype === "error_max_structured_output_retries")
    return Result.fail(
      CompletionInvalid.make({
        sessionId,
        message: "Claude Code returned no value that matches the output schema within its retries",
      }),
    );
  if (result.subtype !== "success")
    return Result.fail(resultFailure(sessionId, result, providerFailure));
  const refusal = apiErrorRefusal(sessionId, result, providerFailure);
  if (Option.isSome(refusal)) return Result.fail(refusal.value);
  const text = result.result?.trim() ?? "";
  if (result.is_error === true)
    return Result.fail(
      AgentResultError.make({
        sessionId: Option.some(sessionId),
        message: text || "Claude ended the completion on an API error",
      }),
    );
  if (result.stop_reason === "refusal")
    return Result.fail(
      CompletionRefused.make({ sessionId, message: text || "Claude declined to answer" }),
    );
  if (result.structured_output === undefined)
    return Result.fail(
      CompletionInvalid.make({ sessionId, message: "Claude returned no structured value" }),
    );
  return Result.succeed(result.structured_output);
};

/** The messages of a Claude Code launch, which a completion reads to its result. */
export interface CompletionMessages {
  /** The messages that the login check already read, in order. */
  readonly read: ReadonlyArray<Schema.Json>;
  readonly output: Queue.Dequeue<Schema.Json, SessionOperationError | Cause.Done>;
  /** Checkpoints a handled message. */
  readonly acknowledge: (message: Schema.Json) => Effect.Effect<void>;
}

/**
 * Reads a completion's messages to its result and returns the value with the usage of `session`.
 * A capacity refusal while the usage limit rejects requests carries the limit's reset time.
 */
export const readClaudeCompletion = Effect.fn("ClaudeRuntime.readCompletion")(function* (
  spec: SessionSpec,
  session: AgentSession,
  launch: CompletionMessages,
) {
  const tokens = claudeTokenMeter();
  let usage = SessionTokensUpdated.make({ session, totalTokens: TokenCount.make(0) });
  let providerFailure = Option.none<AgentCapacityError | AgentResultError>();
  let limitResetsAt = Option.none<DateTime.Utc>();
  let result = Option.none<typeof ClaudeResultMessage.Type>();
  yield* Stream.concat(Stream.fromIterable(launch.read), Stream.fromQueue(launch.output)).pipe(
    Stream.takeUntil(Schema.is(ClaudeResultMessage)),
    Stream.runForEach((message) =>
      Effect.gen(function* () {
        const used = tokens.read(message);
        if (Option.isSome(used))
          usage = SessionTokensUpdated.make({
            session,
            totalTokens: used.value.totalTokens,
            costUsd: used.value.costUsd,
          });
        if (isRateLimitEvent(message)) limitResetsAt = rejectedUntil(message);
        const retry = decodeApiRetry(message);
        if (Option.isSome(retry)) {
          providerFailure = apiRetryFailure(session.id, retry.value);
          yield* Effect.logWarning("Claude completion cannot reach its provider and will retry", {
            sessionId: session.id,
            message: apiRetryMessage(retry.value),
          });
        }
        if (isAssistantMessage(message))
          providerFailure = assistantFailure(session.id, message, providerFailure);
        if (Schema.is(ClaudeResultMessage)(message)) result = Option.some(message);
        yield* launch.acknowledge(message);
      }),
    ),
  );
  if (Option.isNone(result))
    return yield* SessionOperationError.make({
      operation: "stream",
      sessionId: Option.some(spec.session.id),
      message: "Claude output closed without a completion",
      cause: new Error("unexpected end of output"),
    });
  const outcome = completionOutcome(session.id, result.value, providerFailure);
  if (outcome._tag === "Success") return { value: outcome.success, usage } satisfies CompletionJson;
  const failure = outcome.failure;
  if (Schema.is(AgentCapacityError)(failure))
    return yield* AgentCapacityError.make({
      sessionId: failure.sessionId,
      message: failure.message,
      resetsAt: Option.orElse(failure.resetsAt, () => limitResetsAt),
    });
  return yield* Schema.is(AgentResultError)(failure) ? failedCompletion(failure) : failure;
});
