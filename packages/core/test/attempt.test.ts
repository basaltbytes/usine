import { describe, expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { ChildSessionBudget, ChildSessionCount } from "../src/agent/session.ts";
import { AttemptNumber, shouldAutoRetry } from "../src/attempt/attempt.ts";
import {
  AgentFailure,
  ChildSessionBudgetFailure,
  InfraFailure,
  isAutoRetryableFailure,
  RunawayFailure,
} from "../src/attempt/failure.ts";
import { Event } from "../src/event.ts";
import { DedupKey, EventId } from "../src/ids.ts";

const infra = new InfraFailure({ message: "worker unreachable", cause: new Error("ECONNREFUSED") });
const agent = new AgentFailure({ message: "agent reported failure" });
const runaway = new RunawayFailure({ ceiling: "tokens" });
const childBudget = new ChildSessionBudgetFailure({
  maxChildren: ChildSessionBudget.make(4),
  attemptedChildren: ChildSessionCount.make(5),
});
const n = AttemptNumber.make;
const decodeAttemptNumber = Schema.decodeUnknownSync(AttemptNumber);
const decodeChildSessionBudget = Schema.decodeUnknownSync(ChildSessionBudget);

describe("auto-retry law (ADR 0002, ADR 0013)", () => {
  it("only infra failures are auto-retryable at the class level", () => {
    expect(isAutoRetryableFailure(infra)).toBe(true);
    expect(isAutoRetryableFailure(agent)).toBe(false);
    expect(isAutoRetryableFailure(runaway)).toBe(false);
    expect(isAutoRetryableFailure(childBudget)).toBe(false);
  });

  it("infra auto-retry stops at the cap", () => {
    expect(shouldAutoRetry({ failure: infra, number: n(1), maxAutoAttempts: n(3) })).toBe(true);
    expect(shouldAutoRetry({ failure: infra, number: n(3), maxAutoAttempts: n(3) })).toBe(false);
  });

  it("agent failures and guard failures never auto-retry, even on the first attempt", () => {
    expect(shouldAutoRetry({ failure: agent, number: n(1), maxAutoAttempts: n(3) })).toBe(false);
    expect(shouldAutoRetry({ failure: runaway, number: n(1), maxAutoAttempts: n(3) })).toBe(false);
    expect(shouldAutoRetry({ failure: childBudget, number: n(1), maxAutoAttempts: n(3) })).toBe(
      false,
    );
  });
});

describe("construction is the only door", () => {
  it("attempt numbers below 1 or fractional are unconstructible", () => {
    expect(() => decodeAttemptNumber(0)).toThrow();
    expect(() => decodeAttemptNumber(-1)).toThrow();
    expect(() => decodeAttemptNumber(1.5)).toThrow();
    expect(decodeAttemptNumber(1)).toBe(1);
  });

  it("child-session budgets below 1 or fractional are unconstructible", () => {
    expect(() => decodeChildSessionBudget(0)).toThrow();
    expect(() => decodeChildSessionBudget(-1)).toThrow();
    expect(() => decodeChildSessionBudget(1.5)).toThrow();
    expect(decodeChildSessionBudget(1)).toBe(1);
  });

  it("empty ids are unconstructible", () => {
    expect(() => Schema.decodeUnknownSync(EventId)("")).toThrow();
  });

  it("an Event rejects payloads that SQLite cannot preserve as JSON", () => {
    const decodeEvent = Schema.decodeUnknownSync(Event);
    expect(() =>
      decodeEvent({
        id: EventId.make("event-1"),
        dedupKey: DedupKey.make("loop/item/revision"),
        payload: { callback: () => "not JSON" },
        receivedAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
      }),
    ).toThrow();
  });
});
