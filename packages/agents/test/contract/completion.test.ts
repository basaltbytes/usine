import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { BillingPool } from "@usine/core/agent/session";
import { DateTime, Effect, Option, Predicate, Result, type Schema, type Scope } from "effect";
import type { CompletionError, CompletionFailure } from "../../src/harness/contract.ts";
import { openCompletionFixture, recordedValues } from "../replay/completion.ts";
import type { Provider } from "../replay/fixture.ts";
import { isJsonObject, type Transcript } from "../replay/transcript.ts";

const harnesses: ReadonlyArray<Provider> = ["claude", "codex", "pi"];

/** The pool that each fixture's credential route resolves. */
const pools = {
  claude: "claudePlan",
  codex: "chatgptPlan",
  pi: "apiKeys",
} satisfies Record<Provider, BillingPool>;

/** Rewrites every string that `rewrite` changes in the harness output of `transcript`. */
const rewriteOutput =
  (rewrite: (text: string) => string) =>
  (transcript: Transcript): Transcript => {
    const walk = (value: Schema.Json): Schema.Json =>
      Predicate.isString(value)
        ? rewrite(value)
        : Array.isArray(value)
          ? value.map(walk)
          : isJsonObject(value)
            ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
            : value;
    return {
      ...transcript,
      entries: transcript.entries.map((entry) =>
        entry.type === "emit_inbound" ? { ...entry, payload: walk(entry.payload) } : entry,
      ),
    };
  };

/** The recorded answer with a label outside the schema's literals, at the same byte length. */
const mislabelled = rewriteOutput((text) => text.replaceAll("fruit", "mango"));

/** Rewrites each object payload of the harness output that `rewrite` changes. */
const rewritePayloads =
  (rewrite: (payload: Readonly<Record<string, Schema.Json>>) => Schema.Json) =>
  (transcript: Transcript): Transcript => ({
    ...transcript,
    entries: transcript.entries.map((entry) =>
      entry.type === "emit_inbound" && isJsonObject(entry.payload)
        ? { ...entry, payload: rewrite(entry.payload) }
        : entry,
    ),
  });

/** The recorded answer with a property that the schema doesn't model, as JSON or as text. */
const withExtraProperty = (transcript: Transcript): Transcript => {
  const walk = (value: Schema.Json): Schema.Json =>
    Predicate.isString(value)
      ? value === `{"label":"fruit"}`
        ? `{"label":"fruit","extra":"x"}`
        : value
      : Array.isArray(value)
        ? value.map(walk)
        : isJsonObject(value)
          ? Object.keys(value).length === 1 && value.label === "fruit"
            ? { label: "fruit", extra: "x" }
            : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
          : value;
  return rewritePayloads(walk)(transcript);
};

/** Claude Code's result message rewritten with `fields`, without its structured value. */
const claudeResult = (fields: Readonly<Record<string, Schema.Json>>) =>
  rewritePayloads((payload) => {
    if (payload.type !== "result") return payload;
    const { structured_output: _value, ...result } = payload;
    return { ...result, ...fields };
  });

/** The Codex turn completion rewritten as failed with `error`. */
const codexFailedTurn = (error: Readonly<Record<string, Schema.Json>>) =>
  rewritePayloads((payload) => {
    const params = payload.params;
    if (payload.method !== "turn/completed" || params === undefined || !isJsonObject(params))
      return payload;
    const turn = params.turn;
    if (turn === undefined || !isJsonObject(turn)) return payload;
    return {
      ...payload,
      params: {
        ...params,
        turn: { ...turn, status: "failed", error: { additionalDetails: null, ...error } },
      },
    };
  });

/** Pi's final message rewritten by `rewrite`, sent as an error event when it ends on an error. */
const piFinalMessage = (
  rewrite: (
    message: Readonly<Record<string, Schema.Json>>,
  ) => Readonly<Record<string, Schema.Json>>,
) =>
  rewritePayloads((payload) => {
    const recorded = payload.message;
    if (payload.type !== "done" || recorded === undefined || !isJsonObject(recorded))
      return payload;
    const message = rewrite(recorded);
    return message.stopReason === "error"
      ? { type: "error", reason: "error", error: message }
      : { ...payload, message };
  });

/** The account's rate-limit snapshots rewritten with their primary window used up. */
const codexLimitReached = rewritePayloads((payload) => {
  const params = payload.params;
  if (
    payload.method !== "account/rateLimits/updated" ||
    params === undefined ||
    !isJsonObject(params)
  )
    return payload;
  const rateLimits = params.rateLimits;
  if (rateLimits === undefined || !isJsonObject(rateLimits)) return payload;
  const primary = rateLimits.primary;
  if (primary === undefined || !isJsonObject(primary)) return payload;
  return {
    ...payload,
    params: { ...params, rateLimits: { ...rateLimits, primary: { ...primary, usedPercent: 100 } } },
  };
});

/** When Pi's rewritten final message ended. */
const PI_FAILED_AT = "2026-11-12T10:00:00.000Z";

const piError = (fields: Readonly<Record<string, Schema.Json>>) =>
  piFinalMessage((message) => ({ ...message, stopReason: "error", ...fields }));

/** A recorded request whose answer is rewritten so that the completion fails for `reason`. */
interface FailedReplay {
  readonly harness: Provider;
  readonly answer: string;
  readonly transform: (transcript: Transcript) => Transcript;
  readonly reason: CompletionFailure["_tag"];
  /** When the capacity refusal resets, as ISO 8601, or `undefined` when it states no reset. */
  readonly resetsAt?: string;
}

const failedReplays: ReadonlyArray<FailedReplay> = [
  ...harnesses.map((harness): FailedReplay => ({
    harness,
    answer: "a value that the schema rejects",
    transform: mislabelled,
    reason: "CompletionInvalid",
  })),
  ...harnesses.map((harness): FailedReplay => ({
    harness,
    answer: "a property that the schema doesn't model",
    transform: withExtraProperty,
    reason: "CompletionInvalid",
  })),
  {
    harness: "claude",
    answer: "a result past the structured output retries",
    transform: claudeResult({
      subtype: "error_max_structured_output_retries",
      is_error: true,
      structured_output: null,
    }),
    reason: "CompletionInvalid",
  },
  {
    harness: "claude",
    answer: "a result without a structured value",
    transform: claudeResult({}),
    reason: "CompletionInvalid",
  },
  {
    harness: "claude",
    answer: "a refusal",
    transform: claudeResult({ stop_reason: "refusal", result: "I can't help with that." }),
    reason: "CompletionRefused",
  },
  {
    harness: "claude",
    answer: "a usage limit",
    transform: claudeResult({
      is_error: true,
      api_error_status: 429,
      result: "You've hit your limit.",
    }),
    reason: "AgentCapacityError",
  },
  {
    harness: "claude",
    answer: "an API error",
    transform: claudeResult({ is_error: true, result: "API Error: 400 invalid request" }),
    reason: "SessionOperationError",
  },
  {
    harness: "codex",
    // Codex reports no refusal, so a declined answer isn't JSON.
    answer: "a declined answer",
    transform: rewriteOutput((text) =>
      text === `{"label":"fruit"}` ? "I can't help with that." : text,
    ),
    reason: "CompletionInvalid",
  },
  {
    harness: "codex",
    answer: "an overloaded server",
    transform: codexFailedTurn({
      message: "The server is overloaded",
      codexErrorInfo: "serverOverloaded",
    }),
    reason: "AgentCapacityError",
  },
  {
    harness: "codex",
    answer: "a usage limit whose window is used up",
    transform: (transcript) =>
      codexFailedTurn({
        message: "You've hit your usage limit.",
        codexErrorInfo: "usageLimitExceeded",
      })(codexLimitReached(transcript)),
    reason: "AgentCapacityError",
    // The recorded snapshot's primary window resets then.
    resetsAt: "2026-11-17T12:42:41.000Z",
  },
  {
    harness: "codex",
    answer: "a failed turn",
    transform: codexFailedTurn({ message: "The turn failed", codexErrorInfo: "other" }),
    reason: "SessionOperationError",
  },
  {
    harness: "pi",
    answer: "a refusal",
    transform: piError({
      rawStopReason: "refusal",
      errorMessage: "The model refused to complete the request",
    }),
    reason: "CompletionRefused",
  },
  {
    harness: "pi",
    answer: "an overloaded provider",
    transform: piError({ rawStopReason: "error", errorMessage: "overloaded_error" }),
    reason: "AgentCapacityError",
  },
  {
    harness: "pi",
    answer: "a ChatGPT plan usage limit",
    transform: piError({
      rawStopReason: "error",
      errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.",
      timestamp: Date.parse(PI_FAILED_AT),
    }),
    reason: "AgentCapacityError",
    // Pi rounds the stated wait, so the limit resets a minute after it.
    resetsAt: "2026-11-12T10:06:00.000Z",
  },
  {
    harness: "pi",
    answer: "a failed request",
    transform: piError({ rawStopReason: "error", errorMessage: "Provider stopped with: error" }),
    reason: "SessionOperationError",
  },
  {
    harness: "pi",
    answer: "text without the output tool",
    transform: piFinalMessage((message) => ({
      ...message,
      stopReason: "stop",
      content: [{ type: "text", text: "I can't help with that." }],
    })),
    reason: "CompletionInvalid",
  },
  {
    harness: "pi",
    answer: "output tool arguments that aren't JSON",
    transform: piFinalMessage((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((content) =>
            isJsonObject(content) ? { ...content, argumentsError: "Unexpected token" } : content,
          )
        : [],
    })),
    reason: "CompletionInvalid",
  },
];

/** Asserts that `failure` failed for `reason` and carries the recorded request's usage. */
const assertFailedWithUsage = (
  harness: Provider,
  failure: CompletionError,
  reason: CompletionFailure["_tag"],
  resetsAt?: string,
) => {
  assert.strictEqual(failure.reason._tag, reason, failure.message);
  if (failure.reason._tag === "AgentCapacityError")
    assert.deepStrictEqual(
      Option.map(failure.reason.resetsAt, DateTime.formatIso),
      Option.fromUndefinedOr(resetsAt),
      "the capacity refusal resets when the harness reported",
    );
  assert(Option.isSome(failure.usage), "the failure carries the completion's usage");
  assert.isAbove(failure.usage.value.totalTokens, 0, "the failure reports its tokens");
  assert.deepStrictEqual(failure.usage.value.session.pool, Option.some(pools[harness]));
};

const replay = <A, E>(test: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
  test.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("15 seconds"));

describe("structured completion contract", () => {
  for (const harness of harnesses) {
    it.live(
      `${harness}: structured-result decodes the recorded value`,
      () =>
        replay(
          Effect.gen(function* () {
            const fixture = yield* openCompletionFixture(harness, "structured-result", "replay");
            const completion = yield* fixture.run;
            assert(Result.isSuccess(completion), "the recorded value decodes");
            assert.deepStrictEqual(completion.success.value, recordedValues["structured-result"]);
            const { usage } = completion.success;
            assert.isAbove(usage.totalTokens, 0, "the completion reports its tokens");
            assert.deepStrictEqual(usage.session.pool, Option.some(pools[harness]));
            assert.strictEqual(usage.session._tag, "RoleSession");
            yield* fixture.save;
          }),
        ),
      20_000,
    );

    it.live(
      `${harness}: ephemeral saves no conversation and returns no session reference`,
      () =>
        replay(
          Effect.gen(function* () {
            const fixture = yield* openCompletionFixture(harness, "ephemeral", "replay");
            const completion = yield* fixture.run;
            assert(Result.isSuccess(completion));
            assert.deepStrictEqual(completion.success.value, recordedValues.ephemeral);
            yield* fixture.save;
          }),
        ),
      20_000,
    );
  }

  for (const { harness, answer, transform, reason, resetsAt } of failedReplays)
    it.live(
      `${harness}: structured-result with ${answer} fails with ${reason}`,
      () =>
        replay(
          Effect.gen(function* () {
            const fixture = yield* openCompletionFixture(harness, "structured-result", "replay", {
              transform,
            });
            const completion = yield* fixture.run;
            assert(Result.isFailure(completion), `${answer} has no value`);
            assertFailedWithUsage(harness, completion.failure, reason, resetsAt);
            yield* fixture.save;
          }),
        ),
      20_000,
    );
});
