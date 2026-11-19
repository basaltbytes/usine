import { describe, expect, it } from "@effect/vitest";
import { Effect, DateTime, Duration, Option, Schema } from "effect";
import { ChildSessionBudget, ChildSessionCount } from "../src/agent/session.ts";
import {
  AttemptId,
  ContainerOutOfMemoryKills,
  MAX_KILLED_PROCESSES,
  MemoryKilledProcess,
  OutOfMemoryKills,
  AttemptNumber,
  AttemptWindow,
  capacityBackoff,
  pendingProviderRetry,
  shouldAutoRetry,
  totalOutOfMemoryKills,
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
import { AttemptFailed } from "../src/attempt/outcome.ts";
import { SalvageRetained } from "../src/attempt/salvage.ts";
import { Running } from "../src/run/state.ts";
import { ContainerId, ContainerMemoryMib } from "../src/worker.ts";
import { RepositoryName } from "../src/repository.ts";

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

  const failed = (failure: InfraFailure | ProviderCapacityFailure) => ({
    outcome: Option.some(AttemptFailed.make({ failure })),
  });
  const capacity = ProviderCapacityFailure.make({ message: "At capacity" });

  it("automatic retries stop at the cap and never start for a non-retryable failure", () => {
    expect(shouldAutoRetry({ failure: infra, earlier: [], maxAutoAttempts: n(3) })).toBe(true);
    expect(
      shouldAutoRetry({
        failure: infra,
        earlier: [failed(infra), failed(infra)],
        maxAutoAttempts: n(3),
      }),
    ).toBe(false);
    expect(shouldAutoRetry({ failure: agent, earlier: [], maxAutoAttempts: n(3) })).toBe(false);
  });

  it("always retries a capacity refusal, and doesn't count refusals toward the cap", () => {
    const refusals = Array.from({ length: 10 }, () => failed(capacity));
    expect(shouldAutoRetry({ failure: capacity, earlier: refusals, maxAutoAttempts: n(3) })).toBe(
      true,
    );
    expect(
      shouldAutoRetry({
        failure: infra,
        earlier: [...refusals, failed(infra)],
        maxAutoAttempts: n(3),
      }),
    ).toBe(true);
  });
});

describe("provider retry deadline", () => {
  const endedAt = DateTime.makeUnsafe("2026-11-11T03:00:00Z");
  const refused = (number: number, resetsAt: Option.Option<DateTime.Utc>) => ({
    number: n(number),
    outcome: Option.some(
      AttemptFailed.make({
        failure: ProviderCapacityFailure.make({ message: "Usage limit reached", resetsAt }),
      }),
    ),
    endedAt: Option.some(endedAt),
  });
  const retryAt = (refusals: number, resetsAt: Option.Option<DateTime.Utc>) =>
    pendingProviderRetry(
      Running.make(),
      Array.from({ length: refusals }, (_, index) =>
        refused(index + 1, index === refusals - 1 ? resetsAt : Option.none()),
      ),
    ).pipe(Option.map(({ retryAt }) => DateTime.formatIso(retryAt)));

  it.each([
    [1, Option.none(), "2026-11-11T03:05:00.000Z"],
    [2, Option.none(), "2026-11-11T03:15:00.000Z"],
    [3, Option.none(), "2026-11-11T03:30:00.000Z"],
    [4, Option.none(), "2026-11-11T04:00:00.000Z"],
    [9, Option.none(), "2026-11-11T04:00:00.000Z"],
    [1, Option.some(DateTime.makeUnsafe("2026-11-11T05:00:00Z")), "2026-11-11T05:00:00.000Z"],
    [2, Option.some(DateTime.makeUnsafe("2026-11-11T03:01:00Z")), "2026-11-11T03:15:00.000Z"],
  ] as const)(
    "retries after %i consecutive refusals no earlier than the backoff or the reported reset time",
    (refusals, resetsAt, expected) => {
      expect(retryAt(refusals, resetsAt)).toStrictEqual(Option.some(expected));
    },
  );

  it("grows the backoff to a 60-minute ceiling", () => {
    expect(
      [1, 2, 3, 4, 5, 50].map((refusals) => Duration.toMinutes(capacityBackoff(refusals))),
    ).toStrictEqual([5, 15, 30, 60, 60, 60]);
  });

  it("keeps the wait for an earlier reset that a later refusal doesn't report", () => {
    const reset = DateTime.makeUnsafe("2026-11-11T08:00:00Z");
    const retry = pendingProviderRetry(Running.make(), [
      refused(1, Option.some(reset)),
      refused(2, Option.none()),
    ]);
    expect(Option.map(retry, ({ retryAt }) => DateTime.formatIso(retryAt))).toStrictEqual(
      Option.some("2026-11-11T08:00:00.000Z"),
    );
  });

  it.effect("decodes a stored capacity failure without a reset time", () =>
    Effect.gen(function* () {
      const failure = yield* Schema.decodeEffect(ProviderCapacityFailure)({
        _tag: "ProviderCapacityFailure",
        message: "At capacity",
      });
      expect(Option.isNone(failure.resetsAt)).toBe(true);
    }),
  );
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
  it.effect(
    "reads older retained salvage and preserves a non-retryable push failure through JSON",
    () =>
      Effect.gen(function* () {
        const legacy = {
          _tag: "Retained",
          path: "/checkout",
          commit: null,
          message: "push failed",
        } as const;
        expect(
          Option.isNone((yield* Schema.decodeEffect(SalvageRetained)(legacy)).pushFailure),
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
        const decodedValue1 = yield* Schema.encodeEffect(json)(retained);
        const decodedValue2 = yield* Schema.decodeEffect(json)(decodedValue1);
        expect(decodedValue2).toEqual(retained);
      }),
  );
});

describe("older OOM records", () => {
  it.effect("decodes records from before process details were collected", () =>
    Effect.gen(function* () {
      const fields = { kills: 2, memoryMib: 6656 };
      const total = yield* Schema.decodeEffect(OutOfMemoryKills)(fields);
      const container = yield* Schema.decodeEffect(ContainerOutOfMemoryKills)({
        ...fields,
        container: "a".repeat(64),
      });
      expect(total.processes).toEqual([]);
      expect(container.processes).toEqual([]);
    }),
  );
});

describe("killed process lists", () => {
  const processes = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      MemoryKilledProcess.make({ command: "node", pid: index + 1 }),
    );
  const container = "a".repeat(64);

  it.effect("keeps the first processes of a record written before the cap", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeEffect(ContainerOutOfMemoryKills)({
        container,
        kills: MAX_KILLED_PROCESSES + 5,
        memoryMib: 6656,
        processes: processes(MAX_KILLED_PROCESSES + 5),
      });
      expect(decoded.kills).toBe(MAX_KILLED_PROCESSES + 5);
      expect(decoded.processes).toEqual(processes(MAX_KILLED_PROCESSES));
    }),
  );

  it("caps the processes of the containers together and counts every kill", () => {
    const record = (count: number) =>
      ContainerOutOfMemoryKills.make({
        container: ContainerId.make(container),
        kills: count,
        memoryMib: ContainerMemoryMib.make(6656),
        processes: processes(count),
      });
    const total = totalOutOfMemoryKills([record(MAX_KILLED_PROCESSES), record(3)]);
    expect(total.kills).toBe(MAX_KILLED_PROCESSES + 3);
    expect(total.processes).toHaveLength(MAX_KILLED_PROCESSES);
  });
});
