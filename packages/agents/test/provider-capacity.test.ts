import { assert, it } from "@effect/vitest";
import { AgentSessionId, RateLimitsSnapshot, RateLimitWindow } from "@usine/core/agent/session";
import { DateTime, Effect, Option, Schema } from "effect";
import { exhaustedUntil, turnFailure } from "../src/harness/codex/codec.ts";
import { resultFailure } from "../src/harness/claude/codec.ts";
import { AgentCapacityError } from "../src/runtime.ts";
import { TurnCompleted } from "../src/protocol/codex/codex.ts";

it.effect.each([
  {
    code: "serverOverloaded",
    message: "The provider refused the request",
    expected: "AgentCapacityError",
  },
  { code: "other", message: "Selected model is at capacity", expected: "AgentCapacityError" },
  { code: "unauthorized", message: "Selected model is at capacity", expected: "AgentResultError" },
  { code: "rateLimitExceeded", message: "Rate limit reached", expected: "AgentCapacityError" },
  {
    code: "usageLimitExceeded",
    message: "You've hit your usage limit. Try again later.",
    expected: "AgentCapacityError",
  },
  {
    code: "usageLimitExceeded",
    message: "Quota exceeded. Check your plan and billing details.",
    expected: "AgentResultError",
  },
  {
    code: "usageLimitExceeded",
    message:
      "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
    expected: "AgentResultError",
  },
  {
    code: { httpConnectionFailed: { httpStatusCode: 529 } },
    message: "Unavailable",
    expected: "AgentCapacityError",
  },
  {
    code: { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
    message: "Try again later",
    expected: "AgentCapacityError",
  },
  {
    code: { httpConnectionFailed: { httpStatusCode: 503 } },
    message: "Unavailable",
    expected: "AgentResultError",
  },
  {
    code: { activeTurnNotSteerable: { turnKind: "review" } },
    message: "Not steerable",
    expected: "AgentResultError",
  },
])("uses Codex's structured refusal code: $code", ({ code, message, expected }) =>
  Effect.gen(function* () {
    const { turn } = yield* Schema.decodeEffect(TurnCompleted)({
      turn: {
        id: "turn",
        status: "failed",
        error: { message, codexErrorInfo: code, additionalDetails: null },
      },
    });
    assert.strictEqual(
      turnFailure(AgentSessionId.make("child"), turn.error, message, Option.none())._tag,
      expected,
    );
  }),
);

const window = (usedPercent: number, resetsAt: Option.Option<string>) =>
  Option.some(
    RateLimitWindow.make({
      usedPercent,
      windowDurationMinutes: Option.none(),
      resetsAt: Option.map(resetsAt, DateTime.makeUnsafe),
    }),
  );
const snapshot = (
  primary: Option.Option<RateLimitWindow>,
  secondary: Option.Option<RateLimitWindow> = Option.none(),
) =>
  RateLimitsSnapshot.make({ limitId: Option.none(), limitName: Option.none(), primary, secondary });

it.each([
  {
    name: "the reset of the used-up window",
    limits: snapshot(window(100, Option.some("2026-11-12T05:00:00Z")), window(40, Option.none())),
    expected: Option.some("2026-11-12T05:00:00.000Z"),
  },
  {
    name: "the later reset when both windows are used up",
    limits: snapshot(
      window(100, Option.some("2026-11-12T05:00:00Z")),
      window(100, Option.some("2026-11-15T00:00:00Z")),
    ),
    expected: Option.some("2026-11-15T00:00:00.000Z"),
  },
  {
    name: "no reset when no window is used up",
    limits: snapshot(window(99, Option.some("2026-11-12T05:00:00Z"))),
    expected: Option.none(),
  },
  {
    name: "no reset when a used-up window has no reset time",
    limits: snapshot(window(100, Option.some("2026-11-12T05:00:00Z")), window(100, Option.none())),
    expected: Option.none(),
  },
])("dates a Codex usage limit with $name", ({ limits, expected }) => {
  assert.deepStrictEqual(exhaustedUntil(limits).pipe(Option.map(DateTime.formatIso)), expected);
});

it("keeps Claude turn limits terminal after an earlier capacity retry", () => {
  const sessionId = AgentSessionId.make("child");
  const failure = resultFailure(
    sessionId,
    { type: "result", subtype: "error_max_turns", errors: ["Turn limit exceeded"] },
    Option.some(
      AgentCapacityError.make({ sessionId: Option.some(sessionId), message: "HTTP 529" }),
    ),
  );
  assert.strictEqual(failure._tag, "AgentResultError");
  assert.strictEqual(failure.message, "Turn limit exceeded");
});
