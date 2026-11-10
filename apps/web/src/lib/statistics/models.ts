import type { ModelOutcomeView } from "@usine/orchestrator/operator";
import { spanLabel, tokensLabel, usdLabel } from "~/lib/strings";

/** The fewest merged tasks a model needs before the comparison ranks it. */
const COMPARISON_MINIMUM_TASKS = 5;

const count = (value: number, one: string, many: string): string =>
  `${value.toLocaleString("en")} ${value === 1 ? one : many}`;

/** Returns the whole percent of tasks that passed the first review, as the comparison prints it. */
const firstReviewPercent = ({ firstTimeRight, tasks }: ModelOutcomeView): number =>
  Math.round((firstTimeRight / tasks) * 100);

export const firstReviewTitle = "Tasks that passed the first review, per model";

/** Whether `left` and `right` name the same harness and model. */
export const sameModel = (
  left: Pick<ModelOutcomeView, "harness" | "model">,
  right: Pick<ModelOutcomeView, "harness" | "model">,
): boolean => left.harness === right.harness && left.model === right.model;

/** Returns a median count of review rounds, such as `1 review round` or `1.5 review rounds`. */
const roundsLabel = (rounds: number): string =>
  `${rounds.toLocaleString("en", { maximumFractionDigits: 1 })} ${rounds === 1 ? "review round" : "review rounds"}`;

/** Returns text such as `8 of 12`, the tasks that passed the first review. */
export const firstReviewLabel = ({ firstTimeRight, tasks }: ModelOutcomeView): string =>
  `${firstTimeRight.toLocaleString("en")} of ${tasks.toLocaleString("en")}`;

/**
 * Returns the sentence that compares the models: the model whose tasks passed the first review most
 * often, or why there is no such claim.
 */
export const comparisonLine = (models: ReadonlyArray<ModelOutcomeView>): string | null => {
  if (models.length < 2) return null;
  const ranked = models
    .filter(({ tasks }) => tasks >= COMPARISON_MINIMUM_TASKS)
    .sort(
      (left, right) =>
        firstReviewPercent(right) - firstReviewPercent(left) ||
        left.medianRounds - right.medianRounds ||
        right.tasks - left.tasks,
    );
  const [first, second] = ranked;
  if (first === undefined || second === undefined)
    return `Too few tasks to compare: each model needs at least ${COMPARISON_MINIMUM_TASKS} merged tasks`;
  const share = (outcome: ModelOutcomeView) =>
    `${firstReviewPercent(outcome)}% of ${count(outcome.tasks, "task", "tasks")}`;
  if (firstReviewPercent(first) === firstReviewPercent(second))
    return `${first.model} and ${second.model} passed the first review equally often: ${share(first)} and ${share(second)}`;
  return `${first.model} passed the first review most often: ${share(first)}, against ${share(second)} for ${second.model}`;
};

const restsOn = (tasks: number, of: number): string =>
  tasks === of ? "" : ` from ${count(tasks, "task", "tasks")}`;

/** Returns the sentences that describe one model's tasks, each figure with the tasks it rests on. */
export const modelLines = (outcome: ModelOutcomeView): ReadonlyArray<string> => {
  const perTask = [
    outcome.medianTokens === null
      ? null
      : `${tokensLabel(outcome.medianTokens)} tokens${restsOn(outcome.metered, outcome.tasks)}`,
    outcome.cost === null
      ? null
      : `${outcome.cost.estimate ? "~" : ""}${usdLabel(outcome.cost.medianUsd)}${restsOn(outcome.cost.tasks, outcome.tasks)}`,
    `${spanLabel(outcome.medianMillis)} from first attempt to merge`,
  ].filter((part) => part !== null);
  const last = perTask.pop();
  return [
    `${count(outcome.tasks, "task", "tasks")} merged${outcome.mixed === 0 ? "" : `, ${outcome.mixed.toLocaleString("en")} mixed with another model`}`,
    `${firstReviewLabel(outcome)} passed the first review, median ${roundsLabel(outcome.medianRounds)}`,
    `Median per task: ${perTask.length === 0 ? last : `${perTask.join(", ")}, and ${last}`}`,
  ];
};
