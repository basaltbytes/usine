import { AgentName } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow,
} from "@usine/core/agent/session";
import { DateTime, Option } from "effect";
import { assert, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/core/label";
import { RepositoryName } from "@usine/core/repository";
import { LabelPreflightFinding } from "../src/label-reconciler.ts";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { CiFixRun } from "@usine/engine/run-reader";
import { AgentFailureView } from "../src/operator/attempt.ts";
import { PoolLimitNeed, PreflightFindingNeed, RunFailureNeed } from "../src/operator/need.ts";
import { attentionKey, partitionNeeds, poolLimitNeeds } from "../src/operator/attention.ts";

it("shows a changed preflight finding again and ignores acknowledgements of a different entry", () => {
  const original = PreflightFindingNeed.make({
    id: "preflight-finding",
    finding: LabelPreflightFinding.make({
      repository: RepositoryName.make("test/project"),
      label: GitHubLabelName.make("ready"),
      errorTag: "GitHubApiError",
      message: "Could not create label",
    }),
  });
  const acknowledged = [attentionKey(original)];
  assert.deepStrictEqual(partitionNeeds([original], acknowledged), {
    needsYou: [],
    dismissedNeeds: [original],
  });
  for (const finding of [
    LabelPreflightFinding.make({ ...original.finding, label: GitHubLabelName.make("review") }),
    LabelPreflightFinding.make({ ...original.finding, message: "Label permission denied" }),
  ]) {
    const changed = PreflightFindingNeed.make({ ...original, finding });
    assert.deepStrictEqual(partitionNeeds([changed], acknowledged), {
      needsYou: [changed],
      dismissedNeeds: [],
    });
  }
  const other = PreflightFindingNeed.make({ ...original, id: "another-finding" });
  assert.deepStrictEqual(partitionNeeds([other], acknowledged).needsYou, [other]);
  assert.deepStrictEqual(partitionNeeds([original], []).needsYou, [original]);
});

it("keeps a dismissed Run failure dismissed when its CI fix Run opens or changes state", () => {
  const original = RunFailureNeed.make({
    id: "run-failure:source:attempt-1",
    repository: RepositoryName.make("test/project"),
    runId: RunId.make("source"),
    loop: LoopName.make("test/project/develop"),
    failure: AgentFailureView.make({ message: "CI failed. Fix loop fix: CycleBlocked." }),
  });
  const acknowledged = [attentionKey(original)];
  for (const state of ["Waiting", "Failed"] as const) {
    const linked = RunFailureNeed.make({
      ...original,
      fixRun: CiFixRun.make({ runId: RunId.make("fix"), state }),
    });
    assert.deepStrictEqual(attentionKey(linked), attentionKey(original));
    assert.deepStrictEqual(partitionNeeds([linked], acknowledged).dismissedNeeds, [linked]);
  }
  const changed = RunFailureNeed.make({
    ...original,
    failure: AgentFailureView.make({ message: "CI failed again." }),
  });
  assert.deepStrictEqual(partitionNeeds([changed], acknowledged).needsYou, [changed]);
});

it("warns at 80 percent for either window and skips expired or undated windows", () => {
  const now = DateTime.makeUnsafe("2026-10-29T00:00:00Z");
  const future = DateTime.add(now, { hours: 1 });
  const window = (usedPercent: number, resetsAt: Option.Option<DateTime.Utc>) =>
    Option.some(
      RateLimitWindow.make({ usedPercent, resetsAt, windowDurationMinutes: Option.none() }),
    );
  const snapshot = PoolRateLimitsUpdated.make({
    session: ParentSession.make({
      id: AgentSessionId.make("parent"),
      agent: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("pi"),
        model: ModelId.make("test/model"),
        effort: "high",
      }),
    }),
    pool: "chatgptPlan",
    rateLimits: RateLimitsSnapshot.make({
      limitId: Option.none(),
      limitName: Option.none(),
      primary: window(80, Option.some(future)),
      secondary: window(95, Option.some(future)),
    }),
  });
  const needs = poolLimitNeeds([snapshot], now);
  assert.deepStrictEqual(
    needs.map(({ window, usedPercent }) => [window, usedPercent]),
    [
      ["primary", 80],
      ["secondary", 95],
    ],
  );
  assert(needs.every(({ login }) => Option.isNone(login)));
  for (const primary of [
    Option.none(),
    window(79.9, Option.some(future)),
    window(99, Option.none()),
    window(85, Option.some(now)),
    window(85, Option.some(DateTime.subtract(now, { seconds: 1 }))),
  ]) {
    const changed = PoolRateLimitsUpdated.make({
      ...snapshot,
      rateLimits: RateLimitsSnapshot.make({ ...snapshot.rateLimits, primary }),
    });
    assert.deepStrictEqual(
      poolLimitNeeds([changed], now).map(({ window }) => window),
      ["secondary"],
    );
  }
});

it("keeps pool warnings dismissed within each threshold band and separates pools and windows", () => {
  const original = PoolLimitNeed.make({
    id: "pool-limit:chatgptPlan:primary",
    pool: "chatgptPlan",
    login: Option.none(),
    window: "primary",
    usedPercent: 80,
    resetsAt: DateTime.makeUnsafe("2026-11-03T12:00:00Z"),
  });
  for (const [band, lastPercent] of [
    [80, 89.99],
    [90, 94.99],
    [95, 99.99],
    [100, 110],
  ] as const) {
    const need = PoolLimitNeed.make({ ...original, usedPercent: band });
    const acknowledgements = [attentionKey(need)];
    const updated = PoolLimitNeed.make({ ...need, usedPercent: lastPercent });
    assert.deepStrictEqual(partitionNeeds([updated], acknowledgements), {
      needsYou: [],
      dismissedNeeds: [updated],
    });
    for (const changed of [
      PoolLimitNeed.make({ ...need, pool: "claudePlan" }),
      PoolLimitNeed.make({ ...need, window: "secondary" }),
      ...[90, 95, 100]
        .filter((threshold) => threshold > band)
        .map((usedPercent) => PoolLimitNeed.make({ ...need, usedPercent })),
    ]) {
      assert.deepStrictEqual(partitionNeeds([changed], acknowledgements), {
        needsYou: [changed],
        dismissedNeeds: [],
      });
    }
  }
});
