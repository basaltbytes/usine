import { assert, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { EventId } from "@usine/core/event";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { RunSummary } from "@usine/engine/run-reader";
import { DateTime, Option } from "effect";
import { taskStatisticsView } from "../../src/operator/statistics/tasks.ts";

const now = DateTime.makeUnsafe("2026-10-25T12:00:00Z");
const repository = RepositoryName.make("acme/project");
const summary = (id: string, item: string, loop: string, state: RunState.RunState) => {
  const runId = RunId.make(id);
  return RunSummary.make({
    itemKey: ItemKey.make(item),
    repository,
    run: Run.make({
      id: runId,
      eventId: EventId.make(id),
      loop: LoopName.make(loop),
      state,
      openedAt: now,
    }),
    pullRequestUrl: null,
    attempts: [],
    closedAt: Option.some(now),
    approval: Option.none(),
    resolvedFailureAttemptId: Option.none(),
    runAgain: Option.none(),
    agent: Agent.make({
      name: AgentName.make("developer"),
      brain: BrainSpec.make({
        harness: Harness.make("codex"),
        model: ModelId.make("gpt-5"),
        effort: "high",
      }),
      persona: AgentPersona.make("Work."),
      parentModel: Option.none(),
      parentEffort: Option.none(),
    }),
  });
};

it.each([
  ["rebase-pr", "pr-1", RunState.Succeeded.make(), 0],
  ["review-pr", "pr-1", RunState.Succeeded.make(), 1],
  ["rebase-pr", "pr-2", RunState.Succeeded.make(), 1],
  ["rebase-pr", "pr-1", RunState.Failed.make(), 1],
] as const)(
  "counts successful rounds by loop and item: %s %s %j",
  (loop, item, state, expected) => {
    const view = taskStatisticsView({
      window: "7d",
      now,
      usage: new Map(),
      tasks: [
        {
          repository,
          number: ItemNumber.make(1),
          mergedAt: now,
          budgetResets: 0,
          runs: [
            summary("first", "pr-1", "rebase-pr", RunState.Succeeded.make()),
            summary("second", item, loop, state),
          ],
        },
      ],
    });
    assert.strictEqual(view.firstTimeRight, expected);
  },
);
