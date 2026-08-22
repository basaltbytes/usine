import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { AttemptNumber, shouldAutoRetry } from "../src/lifecycle/attempt.ts";
import {
  AgentFailure,
  InfraFailure,
  isAutoRetryable,
  RunawayFailure,
} from "../src/lifecycle/attempt-failure.ts";
import { EventId } from "../src/lifecycle/event.ts";

const infra = new InfraFailure({ message: "worker unreachable", cause: new Error("ECONNREFUSED") });
const agent = new AgentFailure({ message: "agent reported failure" });
const runaway = new RunawayFailure({ ceiling: "tokens" });
const n = AttemptNumber.make;
const decodeAttemptNumber = Schema.decodeUnknownSync(AttemptNumber);

describe("auto-retry law (ADR 0002, ADR 0013)", () => {
  it("only infra failures are auto-retryable at the class level", () => {
    expect(isAutoRetryable(infra)).toBe(true);
    expect(isAutoRetryable(agent)).toBe(false);
    expect(isAutoRetryable(runaway)).toBe(false);
  });

  it("infra auto-retry stops at the cap", () => {
    expect(shouldAutoRetry({ failure: infra, number: n(1), maxAutoAttempts: n(3) })).toBe(true);
    expect(shouldAutoRetry({ failure: infra, number: n(3), maxAutoAttempts: n(3) })).toBe(false);
  });

  it("agent failures and runaways never auto-retry, even on the first attempt", () => {
    expect(shouldAutoRetry({ failure: agent, number: n(1), maxAutoAttempts: n(3) })).toBe(false);
    expect(shouldAutoRetry({ failure: runaway, number: n(1), maxAutoAttempts: n(3) })).toBe(false);
  });
});

describe("construction is the only door", () => {
  it("attempt numbers below 1 or fractional are unconstructible", () => {
    expect(() => decodeAttemptNumber(0)).toThrow();
    expect(() => decodeAttemptNumber(-1)).toThrow();
    expect(() => decodeAttemptNumber(1.5)).toThrow();
    expect(decodeAttemptNumber(1)).toBe(1);
  });

  it("empty ids are unconstructible", () => {
    expect(() => Schema.decodeUnknownSync(EventId)("")).toThrow();
  });
});
