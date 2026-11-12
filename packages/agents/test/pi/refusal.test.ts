import { assert, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import { DateTime, Option } from "effect";
import { piFailure } from "../../src/harness/pi/refusal.ts";

const timestamp = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-12T04:17:00Z"));

it.each([
  {
    name: "a ChatGPT plan limit with its wait",
    errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.",
    expected: "AgentCapacityError",
    resetsAt: Option.some("2026-11-12T05:00:00.000Z"),
  },
  {
    name: "a ChatGPT plan limit without a reset time",
    errorMessage: "You have hit your ChatGPT usage limit (plus plan).",
    expected: "AgentCapacityError",
    resetsAt: Option.none(),
  },
  {
    name: "a ChatGPT plan limit relayed over WebSocket",
    errorMessage: "Codex error: The usage limit has been reached",
    expected: "AgentCapacityError",
    resetsAt: Option.none(),
  },
  {
    name: "a shared ChatGPT subscription limit",
    errorMessage:
      'OpenAI API error (429): {"code":"subscription_sharing_usage_limit_exceeded"}\nCheck your ChatGPT usage: https://chatgpt.com/codex/settings/usage',
    expected: "AgentCapacityError",
    resetsAt: Option.none(),
  },
  {
    name: "an API-key rate limit",
    errorMessage:
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}',
    expected: "AgentCapacityError",
    resetsAt: Option.none(),
  },
  {
    name: "an exhausted API-key quota",
    errorMessage:
      "429 You exceeded your current quota, please check your plan and billing details. (insufficient_quota)",
    expected: "AgentResultError",
    resetsAt: Option.none(),
  },
  {
    name: "billing exhaustion with rate-limit text",
    errorMessage:
      "429 Rate limit reached for requests. insufficient_quota: check your billing details",
    expected: "AgentResultError",
    resetsAt: Option.none(),
  },
  {
    name: "an exhausted Gemini quota",
    errorMessage:
      '429 {"error":{"code":429,"message":"Resource has been exhausted: Quota exceeded for metric generate_content_requests","status":"RESOURCE_EXHAUSTED"}}',
    expected: "AgentResultError",
    resetsAt: Option.none(),
  },
  {
    name: "HTTP 429 without rate-limit text",
    errorMessage: "Error: model returned 429 items",
    expected: "AgentResultError",
    resetsAt: Option.none(),
  },
  {
    name: "a rate limit without HTTP 429",
    errorMessage: "Rate limit settings are invalid",
    expected: "AgentResultError",
    resetsAt: Option.none(),
  },
  {
    name: "an overload",
    errorMessage: "HTTP 529: overloaded_error",
    expected: "AgentCapacityError",
    resetsAt: Option.none(),
  },
])("classifies $name", ({ errorMessage, expected, resetsAt }) => {
  const failure = piFailure(AgentSessionId.make("child"), { errorMessage, timestamp });
  assert.strictEqual(failure._tag, expected);
  assert.strictEqual(failure.message, errorMessage);
  if (failure._tag === "AgentCapacityError")
    assert.deepStrictEqual(failure.resetsAt.pipe(Option.map(DateTime.formatIso)), resetsAt);
});
