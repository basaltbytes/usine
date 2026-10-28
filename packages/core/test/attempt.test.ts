import { describe, expect, it } from "@effect/vitest";
import { DateTime, Option, Schema } from "effect";
import { ChildSessionBudget, ChildSessionCount } from "../src/agent/session.ts";
import {
  AttemptId,
  FailureResolution,
  AttemptNumber,
  AttemptWindow,
  shouldAutoRetry,
  windowsOverlap,
} from "../src/attempt/attempt.ts";
import {
  GitHubPushFailure,
  AgentFailure,
  ChildSessionBudgetFailure,
  DefectFailure,
  InfraFailure,
  isAutoRetryableFailure,
  RunawayFailure,
} from "../src/attempt/failure.ts";
import { SalvageRetained } from "../src/attempt/salvage.ts";
import { RepositoryName } from "../src/repository.ts";
import { Event, DedupKey, EventId } from "../src/event.ts";

const infra = new InfraFailure({ message: "worker unreachable", cause: new Error("ECONNREFUSED") });
const defect = new DefectFailure({ message: "executor crashed", cause: new Error("bug") });
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
    expect(isAutoRetryableFailure(defect)).toBe(false);
    expect(isAutoRetryableFailure(runaway)).toBe(false);
    expect(isAutoRetryableFailure(childBudget)).toBe(false);
  });

  it("infra auto-retry stops at the cap", () => {
    expect(shouldAutoRetry({ failure: infra, number: n(1), maxAutoAttempts: n(3) })).toBe(true);
    expect(shouldAutoRetry({ failure: infra, number: n(3), maxAutoAttempts: n(3) })).toBe(false);
  });

  it("agent, defect, and guard failures never auto-retry, even on the first attempt", () => {
    expect(shouldAutoRetry({ failure: defect, number: n(1), maxAutoAttempts: n(3) })).toBe(false);
    expect(shouldAutoRetry({ failure: agent, number: n(1), maxAutoAttempts: n(3) })).toBe(false);
    expect(shouldAutoRetry({ failure: runaway, number: n(1), maxAutoAttempts: n(3) })).toBe(false);
    expect(shouldAutoRetry({ failure: childBudget, number: n(1), maxAutoAttempts: n(3) })).toBe(
      false,
    );
  });
});

describe("construction is the only door", () => {
  it("rejects a resolution with an invalid time, operator, or unknown field", () => {
    const decode = Schema.decodeUnknownSync(FailureResolution);
    const resolution = { resolvedAt: "2026-10-27T00:00:00Z", operator: "Philippe" };
    expect(() => decode({ ...resolution, resolvedAt: "not-a-time" })).toThrow();
    expect(() => decode({ ...resolution, operator: "" })).toThrow();
    expect(() => decode({ ...resolution, retry: true })).toThrow();
  });

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

describe("Attempt windows", () => {
  const window = (id: string, startedAt: string, endedAt: string | null) =>
    new AttemptWindow({
      attemptId: AttemptId.make(id),
      startedAt: DateTime.makeUnsafe(startedAt),
      endedAt: endedAt === null ? Option.none() : Option.some(DateTime.makeUnsafe(endedAt)),
    });

  // GitHub timestamps a comment posted at 12:00:00.600 as 12:00:00, which is inside both windows.
  it("overlap when one ends in the second the other starts, and never once it ended a second before", () => {
    const ended = window("review/1", "2026-10-21T11:00:00.000Z", "2026-10-21T12:00:00.400Z");
    expect(windowsOverlap(ended, window("fix/1", "2026-10-21T12:00:00.700Z", null))).toBe(true);
    expect(windowsOverlap(window("fix/1", "2026-10-21T12:00:00.700Z", null), ended)).toBe(true);
    expect(windowsOverlap(ended, window("fix/1", "2026-10-21T12:00:01.000Z", null))).toBe(false);
  });
});

describe("retained push refusal", () => {
  it("reads older retained salvage and preserves a non-retryable push failure through JSON", () => {
    const legacy = {
      _tag: "Retained",
      path: "/checkout",
      commit: null,
      message: "push failed",
    } as const;
    expect(Option.isNone(Schema.decodeUnknownSync(SalvageRetained)(legacy).pushFailure)).toBe(true);
    const failure = new GitHubPushFailure({
      repository: RepositoryName.make("acme/demo"),
      ref: "refs/heads/usine/salvage/run/1",
      message: "GitHub refused the push (HTTP 403)",
    });
    expect(isAutoRetryableFailure(failure)).toBe(false);
    const retained = new SalvageRetained({
      ...legacy,
      commit: Option.none(),
      pushFailure: Option.some(failure),
    });
    const json = Schema.fromJsonString(SalvageRetained);
    expect(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(retained))).toEqual(retained);
  });
});
