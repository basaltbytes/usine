import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ParentSession,
  PoolRateLimitsUpdated,
  RateLimitsSnapshot,
  RateLimitWindow,
} from "@usine/core/agent/session";
import { DateTime, Option } from "effect";
import { assert, it } from "@effect/vitest";
import { GitHubLabelName } from "@usine/config/label";
import { RepositoryName } from "@usine/core/repository";
import { LabelPreflightFinding } from "../src/label-reconciler.ts";
import { PoolLimitNeed, PreflightFindingNeed } from "../src/operator/need.ts";
import { attentionKey, partitionNeeds, poolLimitNeeds } from "../src/operator/attention.ts";

it("shows a changed preflight finding again and ignores acknowledgements of a different entry", () => {
  const original = new PreflightFindingNeed({
    id: "preflight-finding",
    finding: new LabelPreflightFinding({
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
    new LabelPreflightFinding({ ...original.finding, label: GitHubLabelName.make("review") }),
    new LabelPreflightFinding({ ...original.finding, message: "Label permission denied" }),
  ]) {
    const changed = new PreflightFindingNeed({ ...original, finding });
    assert.deepStrictEqual(partitionNeeds([changed], acknowledged), {
      needsYou: [changed],
      dismissedNeeds: [],
    });
  }
  const other = new PreflightFindingNeed({ ...original, id: "another-finding" });
  assert.deepStrictEqual(partitionNeeds([other], acknowledged).needsYou, [other]);
  assert.deepStrictEqual(partitionNeeds([original], []).needsYou, [original]);
});

it("warns at 80 percent for either window and skips expired or undated windows", () => {
  const now = DateTime.makeUnsafe("2026-10-29T00:00:00Z");
  const future = DateTime.add(now, { hours: 1 });
  const window = (usedPercent: number, resetsAt: Option.Option<DateTime.Utc>) =>
    Option.some(
      new RateLimitWindow({ usedPercent, resetsAt, windowDurationMinutes: Option.none() }),
    );
  const snapshot = new PoolRateLimitsUpdated({
    session: new ParentSession({
      id: AgentSessionId.make("parent"),
      agent: AgentName.make("developer"),
      brain: new BrainSpec({ harness: "pi", model: ModelId.make("test/model"), effort: "high" }),
    }),
    pool: "chatgptPlan",
    rateLimits: new RateLimitsSnapshot({
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
    const changed = new PoolRateLimitsUpdated({
      ...snapshot,
      rateLimits: new RateLimitsSnapshot({ ...snapshot.rateLimits, primary }),
    });
    assert.deepStrictEqual(
      poolLimitNeeds([changed], now).map(({ window }) => window),
      ["secondary"],
    );
  }
});

it("keeps pool warnings dismissed within each threshold band and separates pools and windows", () => {
  const original = new PoolLimitNeed({
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
    const need = new PoolLimitNeed({ ...original, usedPercent: band });
    const acknowledgements = [attentionKey(need)];
    const updated = new PoolLimitNeed({ ...need, usedPercent: lastPercent });
    assert.deepStrictEqual(partitionNeeds([updated], acknowledgements), {
      needsYou: [],
      dismissedNeeds: [updated],
    });
    for (const changed of [
      new PoolLimitNeed({ ...need, pool: "claudePlan" }),
      new PoolLimitNeed({ ...need, window: "secondary" }),
      ...[90, 95, 100]
        .filter((threshold) => threshold > band)
        .map((usedPercent) => new PoolLimitNeed({ ...need, usedPercent })),
    ]) {
      assert.deepStrictEqual(partitionNeeds([changed], acknowledgements), {
        needsYou: [changed],
        dismissedNeeds: [],
      });
    }
  }
});
