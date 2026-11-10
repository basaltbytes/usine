import { Harness, ModelId } from "@usine/core/agent/brain";
import { TokenCount, UsdAmount } from "@usine/core/agent/session";
import { ModelOutcomeView, TaskCostView } from "@usine/orchestrator/operator";
import { expect, it } from "vitest";
import { comparisonLine, modelLines } from "./models";

const outcome = (
  model: string,
  tasks: number,
  firstTimeRight: number,
  medianRounds = 1,
): ModelOutcomeView =>
  ModelOutcomeView.make({
    harness: Harness.make("codex"),
    model: ModelId.make(model),
    tasks,
    mixed: 0,
    firstTimeRight,
    medianRounds,
    medianMillis: 3 * 3_600_000,
    metered: tasks,
    medianTokens: TokenCount.make(2_300_000),
    cost: TaskCostView.make({ tasks, medianUsd: UsdAmount.make(3.1), estimate: true }),
  });

it.each([
  ["one model", [outcome("gpt-5", 9, 3)], null],
  [
    "a model under the minimum",
    [outcome("gpt-5", 9, 3), outcome("opus", 4, 4)],
    "Too few tasks to compare: each model needs at least 5 merged tasks",
  ],
  [
    "two ranked models",
    [outcome("gpt-5", 9, 3), outcome("opus", 6, 4), outcome("haiku", 2, 2)],
    "opus passed the first review most often: 67% of 6 tasks, against 33% of 9 tasks for gpt-5",
  ],
  [
    "a tie",
    [outcome("gpt-5", 10, 5), outcome("opus", 6, 3)],
    "gpt-5 and opus passed the first review equally often: 50% of 10 tasks and 50% of 6 tasks",
  ],
] as const)("compares %s", (_, models, expected) => {
  expect(comparisonLine(models)).toBe(expected);
});

it("states how many tasks each figure rests on", () => {
  expect(
    modelLines(
      ModelOutcomeView.make({
        ...outcome("opus", 12, 8, 1.5),
        mixed: 2,
        metered: 10,
        cost: TaskCostView.make({ tasks: 9, medianUsd: UsdAmount.make(3.1), estimate: true }),
      }),
    ),
  ).toEqual([
    "12 tasks merged, 2 mixed with another model",
    "8 of 12 passed the first review, median 1.5 review rounds",
    "Median per task: 2.3M tokens from 10 tasks, ~$3.10 from 9 tasks, and 3 h from first attempt to merge",
  ]);
  expect(
    modelLines(ModelOutcomeView.make({ ...outcome("opus", 1, 1), medianTokens: null, cost: null })),
  ).toEqual([
    "1 task merged",
    "1 of 1 passed the first review, median 1 review round",
    "Median per task: 3 h from first attempt to merge",
  ]);
});
