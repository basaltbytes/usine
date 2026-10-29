import { assert, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import { Option, Schema } from "effect";
import { turnFailure } from "../src/pi/codex/codec.ts";
import { resultFailure } from "../src/pi/claude/codec.ts";
import { AgentCapacityError } from "../src/runtime.ts";
import { TurnCompleted } from "../src/protocol/codex.ts";

it.each([
  {
    code: "serverOverloaded",
    message: "The provider refused the request",
    expected: "AgentCapacityError",
  },
  { code: "unauthorized", message: "Selected model is at capacity", expected: "AgentResultError" },
  { code: "rateLimitExceeded", message: "Usage limit", expected: "AgentResultError" },
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
])("uses Codex's structured refusal code: $code", ({ code, message, expected }) => {
  const { turn } = Schema.decodeUnknownSync(TurnCompleted)({
    turn: {
      id: "turn",
      status: "failed",
      error: { message, codexErrorInfo: code, additionalDetails: null },
    },
  });
  assert.strictEqual(turnFailure(AgentSessionId.make("child"), turn.error, message)._tag, expected);
});

it("keeps Claude turn limits terminal after an earlier capacity retry", () => {
  const sessionId = AgentSessionId.make("child");
  const failure = resultFailure(
    sessionId,
    { type: "result", subtype: "error_max_turns", errors: ["Turn limit exceeded"] },
    Option.some(new AgentCapacityError({ sessionId: Option.some(sessionId), message: "HTTP 529" })),
  );
  assert.strictEqual(failure._tag, "AgentResultError");
  assert.strictEqual(failure.message, "Turn limit exceeded");
});
