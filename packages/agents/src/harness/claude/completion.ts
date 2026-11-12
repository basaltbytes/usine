import type { AgentSession, AgentSessionId } from "@usine/core/agent/session";
import { SessionTokensUpdated, TokenCount } from "@usine/core/agent/session";
import { type Cause, DateTime, Effect, Option, type Queue, Result, Schema, Stream } from "effect";
import { type AgentCapacityError, AgentResultError, SessionOperationError } from "../../runtime.ts";
import { CompletionReply, type CompletionRequest } from "../completion.ts";
import type { SessionSpec } from "../contract.ts";
import { claudeTokenMeter } from "../usage.ts";
import { apiRetryMessage, ClaudeResultMessage } from "./codec.ts";
import { type ClaudeProviderFailures, claudeProviderFailures } from "./provider.ts";

/**
 * Returns what a structured completion's result answered, or the failure that ended it: Claude
 * Code found no value that matches the schema within its retries, the model declined, the
 * provider refused for capacity, or the turn failed.
 */
const completionOutcome = (
  sessionId: AgentSessionId,
  result: typeof ClaudeResultMessage.Type,
  provider: ClaudeProviderFailures,
): Result.Result<CompletionReply, AgentCapacityError | AgentResultError> => {
  if (result.subtype === "error_max_structured_output_retries")
    return Result.succeed(
      CompletionReply.Missing({
        message: "Claude Code returned no value that matches the output schema within its retries",
      }),
    );
  if (result.subtype !== "success") return Result.fail(provider.failedResult(result));
  const refusal = provider.refusal(result);
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
    return Result.succeed(
      CompletionReply.Declined({ message: text || "Claude declined to answer" }),
    );
  if (result.structured_output === undefined)
    return Result.succeed(
      CompletionReply.Missing({ message: "Claude returned no structured value" }),
    );
  return Result.succeed(CompletionReply.Value({ value: result.structured_output }));
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
 * Reads a completion's messages to its result and returns what it answered, reporting the usage
 * of `session` to `spent`. Provider retries, assistant errors, and rate limits classify a failed
 * result as they do for a session.
 */
export const readClaudeCompletion = Effect.fn("ClaudeRuntime.readCompletion")(function* (
  spec: SessionSpec,
  session: AgentSession,
  launch: CompletionMessages,
  spent: CompletionRequest["spent"],
) {
  const tokens = claudeTokenMeter();
  yield* spent(SessionTokensUpdated.make({ session, totalTokens: TokenCount.make(0) }));
  const provider = claudeProviderFailures(session.id);
  let result = Option.none<typeof ClaudeResultMessage.Type>();
  yield* Stream.concat(Stream.fromIterable(launch.read), Stream.fromQueue(launch.output)).pipe(
    Stream.takeUntil(Schema.is(ClaudeResultMessage)),
    Stream.runForEach((message) =>
      Effect.gen(function* () {
        const used = tokens.read(message);
        if (Option.isSome(used))
          yield* spent(
            SessionTokensUpdated.make({
              session,
              totalTokens: used.value.totalTokens,
              costUsd: used.value.costUsd,
            }),
          );
        const reported = provider.read(message);
        if (Option.isSome(reported.rejectedUntil))
          yield* Effect.logWarning("Claude reports that its usage limit rejects requests", {
            sessionId: session.id,
            resetsAt: DateTime.formatIso(reported.rejectedUntil.value),
          });
        if (Option.isSome(reported.retry))
          yield* Effect.logWarning("Claude completion cannot reach its provider and will retry", {
            sessionId: session.id,
            message: apiRetryMessage(reported.retry.value),
          });
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
  const outcome = completionOutcome(session.id, result.value, provider);
  if (outcome._tag === "Success") return outcome.success;
  return yield* outcome.failure;
});
