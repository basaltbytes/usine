import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { AttemptNumber, shouldAutoRetry } from "../src/Attempt.ts";
import {
  AgentFailure,
  InfraFailure,
  isAutoRetryable,
  RunawayFailure,
} from "../src/AttemptFailure.ts";
import { EventId } from "../src/Event.ts";

const infra = new InfraFailure({ message: "worker unreachable", cause: new Error("ECONNREFUSED") });
const agent = new AgentFailure({ message: "agent reported failure" });
const runaway = new RunawayFailure({ ceiling: "tokens" });
const n = AttemptNumber.make;

describe("auto-retry law (ADR 0002, ADR 0013)", () => {
  it("infra failures auto-retry while under the cap", () => {
    expect(isAutoRetryable(infra)).toBe(true);
    expect(shouldAutoRetry({ failure: infra, number: n(1), maxAutoAttempts: n(3) })).toBe(true);
  });

  it("infra retries stop at the cap", () => {
    expect(shouldAutoRetry({ failure: infra, number: n(3), maxAutoAttempts: n(3) })).toBe(false);
  });

  it("agent failures always wait for the operator", () => {
    expect(isAutoRetryable(agent)).toBe(false);
    expect(shouldAutoRetry({ failure: agent, number: n(1), maxAutoAttempts: n(3) })).toBe(false);
  });

  it("a runaway is never auto-retried, even on the first attempt", () => {
    expect(isAutoRetryable(runaway)).toBe(false);
    expect(shouldAutoRetry({ failure: runaway, number: n(1), maxAutoAttempts: n(3) })).toBe(false);
  });
});

describe("construction is the only door", () => {
  it("attempt numbers below 1 or fractional are unconstructible", () => {
    expect(() => Schema.decodeUnknownSync(AttemptNumber)(0)).toThrow();
    expect(() => Schema.decodeUnknownSync(AttemptNumber)(-1)).toThrow();
    expect(() => Schema.decodeUnknownSync(AttemptNumber)(1.5)).toThrow();
    expect(Schema.decodeUnknownSync(AttemptNumber)(1)).toBe(1);
  });

  it("empty ids are unconstructible", () => {
    expect(() => Schema.decodeUnknownSync(EventId)("")).toThrow();
  });
});
