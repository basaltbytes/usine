import { describe, expect, it } from "@effect/vitest";
import { flow, Effect, DateTime, Option, Schema } from "effect";
import { ChildSessionBudget, ChildSessionCount } from "../src/agent/session.ts";
import {
  AttemptId,
  ProviderRetry,
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
  ProviderCapacityFailure,
  isAutoRetryableFailure,
  RunawayFailure,
} from "../src/attempt/failure.ts";
import { SalvageRetained } from "../src/attempt/salvage.ts";
import { RepositoryName } from "../src/repository.ts";
import { Event, DedupKey, EventId } from "../src/event.ts";

const infra = InfraFailure.make({
  message: "worker unreachable",
  cause: new Error("ECONNREFUSED"),
});
const defect = DefectFailure.make({ message: "executor crashed", cause: new Error("bug") });
const agent = AgentFailure.make({ message: "agent reported failure" });
const runaway = RunawayFailure.make({ ceiling: "tokens" });
const childBudget = ChildSessionBudgetFailure.make({
  maxChildren: ChildSessionBudget.make(4),
  attemptedChildren: ChildSessionCount.make(5),
});
const n = AttemptNumber.make;
const decodeAttemptNumber = flow(Schema.decodeUnknownEffect(AttemptNumber), Effect.runSync);
const decodeChildSessionBudget = flow(
  Schema.decodeUnknownEffect(ChildSessionBudget),
  Effect.runSync,
);

describe("auto-retry law (ADR 0002, ADR 0013)", () => {
  it("infrastructure and capacity failures permit automatic retries", () => {
    expect(isAutoRetryableFailure(infra)).toBe(true);
    expect(isAutoRetryableFailure(ProviderCapacityFailure.make({ message: "At capacity" }))).toBe(
      true,
    );
    expect(isAutoRetryableFailure(agent)).toBe(false);
    expect(isAutoRetryableFailure(defect)).toBe(false);
    expect(isAutoRetryableFailure(runaway)).toBe(false);
    expect(isAutoRetryableFailure(childBudget)).toBe(false);
  });

  it.each([infra, ProviderCapacityFailure.make({ message: "At capacity" })])(
    "automatic retries stop at the cap: $_tag",
    (failure) => {
      expect(shouldAutoRetry({ failure, number: n(1), maxAutoAttempts: n(3) })).toBe(true);
      expect(shouldAutoRetry({ failure, number: n(3), maxAutoAttempts: n(3) })).toBe(false);
    },
  );

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
  it("rejects a provider retry that names the first attempt", () => {
    expect(() =>
      ProviderRetry.make({
        nextAttempt: n(1),
        retryAt: DateTime.makeUnsafe(0),
        message: "At capacity",
      }),
    ).toThrow();
  });
  it("rejects a resolution with an invalid time, operator, or unknown field", () => {
    const decode = flow(Schema.decodeUnknownEffect(FailureResolution), Effect.runSync);
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
    expect(() => Effect.runSync(Schema.decodeEffect(EventId)(""))).toThrow();
  });

  it("an Event rejects payloads that SQLite cannot preserve as JSON", () => {
    const decodeEvent = flow(Schema.decodeUnknownEffect(Event), Effect.runSync);
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
    AttemptWindow.make({
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
    expect(
      Option.isNone(Effect.runSync(Schema.decodeEffect(SalvageRetained)(legacy)).pushFailure),
    ).toBe(true);
    const failure = GitHubPushFailure.make({
      repository: RepositoryName.make("acme/demo"),
      ref: "refs/heads/usine/salvage/run/1",
      message: "GitHub refused the push (HTTP 403)",
    });
    expect(isAutoRetryableFailure(failure)).toBe(false);
    const retained = SalvageRetained.make({
      ...legacy,
      commit: Option.none(),
      pushFailure: Option.some(failure),
    });
    const json = Schema.fromJsonString(SalvageRetained);
    expect(
      Effect.runSync(
        Schema.decodeEffect(json)(Effect.runSync(Schema.encodeEffect(json)(retained))),
      ),
    ).toEqual(retained);
  });
});
