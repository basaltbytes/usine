import { assert, it } from "@effect/vitest";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { EventId } from "@usine/core/event";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { Run, RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { Step, StepName } from "@usine/core/step";
import { RunSummary } from "@usine/engine/run-reader";
import { DateTime, Option } from "effect";
import { taskStatisticsView } from "../../src/operator/statistics/tasks.ts";

const now = DateTime.makeUnsafe("2026-10-25T12:00:00Z");
const repository = RepositoryName.make("acme/project");
const summary = (id: string, item: string, loop: string, state: RunState.RunState) => {
  const runId = RunId.make(id);
  return new RunSummary({
    itemKey: ItemKey.make(item),
    repository,
    run: new Run({
      id: runId,
      eventId: EventId.make(id),
      loop: LoopName.make(loop),
      state,
      openedAt: now,
    }),
    step: new Step({ runId, name: StepName.make("run"), result: Option.none() }),
    attempts: [],
    closedAt: Option.some(now),
    approval: Option.none(),
    resolvedFailureAttemptId: Option.none(),
    runAgain: Option.none(),
    task: AttemptTask.make("Rebase the pull request."),
    agent: new Agent({
      name: AgentName.make("developer"),
      brain: new BrainSpec({ harness: "codex", model: ModelId.make("gpt-5"), effort: "high" }),
      persona: AgentPersona.make("Work."),
      parentModel: Option.none(),
      parentEffort: Option.none(),
    }),
  });
};

it.each([
  ["rebase-pr", "pr-1", new RunState.Succeeded(), 0],
  ["review-pr", "pr-1", new RunState.Succeeded(), 1],
  ["rebase-pr", "pr-2", new RunState.Succeeded(), 1],
  ["rebase-pr", "pr-1", new RunState.Failed(), 1],
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
            summary("first", "pr-1", "rebase-pr", new RunState.Succeeded()),
            summary("second", item, loop, state),
          ],
        },
      ],
    });
    assert.strictEqual(view.firstTimeRight, expected);
  },
);
