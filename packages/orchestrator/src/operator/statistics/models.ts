import type { AgentName } from "@usine/core/agent";
import type { Harness, ModelId } from "@usine/core/agent/brain";
import { TokenCount, UsdAmount } from "@usine/core/agent/session";
import { jsonKey } from "@usine/core/json-key";
import type { AttemptSummary, RunSummary } from "@usine/engine/run-reader";
import { Array as EffectArray, Option } from "effect";
import { AgentModelsView, ModelOutcomeView, TaskCostView } from "./view.ts";
import { epoch, median } from "./window.ts";

/** The usage of a task, all loops summed. */
export interface TaskUsage {
  readonly total: number;
  /** The summed price, or `None` if a session has no price. */
  readonly usd: Option.Option<number>;
  readonly estimate: boolean;
}

/** A task done, as `agentModelsView` attributes it to the models its agents ran with. */
export interface OutcomeTask {
  /** The task's Runs, without those replaced before an Attempt. */
  readonly runs: ReadonlyArray<RunSummary>;
  /** The newest merge among the task's pull requests, in epoch milliseconds. */
  readonly mergedAt: number;
  /** The most successful Runs of one Loop on one of the task's Items. */
  readonly rounds: number;
  /** The task's usage, or `None` if a Run with an Attempt reported none. */
  readonly tokens: Option.Option<TaskUsage>;
}

/** Whether no Loop succeeded twice on one of the task's Items: one review round. */
export const firstTimeRight = ({ rounds }: OutcomeTask): boolean => rounds <= 1;

/** One task as an Agent saw it: the brain of its first Attempt and whether it changed. */
interface AttributedTask {
  readonly agent: AgentName;
  readonly harness: Harness;
  readonly model: ModelId;
  readonly mixed: boolean;
  readonly opened: boolean;
  readonly task: OutcomeTask;
  /** The task's first Attempt start, by any Agent. */
  readonly start: number;
}

const brainKey = ({ brain }: AttemptSummary): string => jsonKey([brain.harness, brain.model]);

const byStart = (left: AttemptSummary, right: AttemptSummary): number =>
  epoch(left.startedAt) - epoch(right.startedAt) || left.id.localeCompare(right.id);

/** Returns one entry per Agent that ran an Attempt on `task`. */
const attribute = (task: OutcomeTask): ReadonlyArray<AttributedTask> => {
  const attempts = task.runs.flatMap(({ attempts }) => attempts).sort(byStart);
  const [first] = attempts;
  if (first === undefined) return [];
  return Object.values(EffectArray.groupBy(attempts, ({ agent }) => agent)).map((members) => {
    const [own] = members;
    return {
      agent: own.agent,
      harness: own.brain.harness,
      model: own.brain.model,
      mixed: members.some((member) => brainKey(member) !== brainKey(own)),
      opened: own.agent === first.agent,
      task,
      start: epoch(first.startedAt),
    };
  });
};

const roundedMedian = (values: ReadonlyArray<number>): number | null =>
  Option.getOrNull(Option.map(median(values), Math.round));

const modelOutcome = (
  members: EffectArray.NonEmptyReadonlyArray<AttributedTask>,
): ModelOutcomeView => {
  const usage = members.flatMap(({ task }) => Option.toArray(task.tokens));
  const prices = usage.flatMap(({ usd }) => Option.toArray(usd));
  const medianTokens = roundedMedian(usage.map(({ total }) => total));
  return ModelOutcomeView.make({
    harness: members[0].harness,
    model: members[0].model,
    tasks: members.length,
    mixed: members.filter(({ mixed }) => mixed).length,
    firstTimeRight: members.filter(({ task }) => firstTimeRight(task)).length,
    medianRounds: Option.getOrElse(median(members.map(({ task }) => task.rounds)), () => 0),
    medianMillis:
      roundedMedian(members.map(({ task, start }) => Math.max(0, task.mergedAt - start))) ?? 0,
    metered: usage.length,
    medianTokens: medianTokens === null ? null : TokenCount.make(medianTokens),
    cost: Option.match(median(prices), {
      onNone: () => null,
      onSome: (usd) =>
        TaskCostView.make({
          tasks: prices.length,
          medianUsd: UsdAmount.make(usd),
          estimate: usage.some(({ usd, estimate }) => Option.isSome(usd) && estimate),
        }),
    }),
  });
};

/**
 * Groups the tasks done by the Agents that ran an Attempt on them, then by the harness and model
 * of each Agent's first Attempt on the task.
 */
export const agentModelsView = (
  tasks: ReadonlyArray<OutcomeTask>,
): ReadonlyArray<AgentModelsView> =>
  Object.values(EffectArray.groupBy(tasks.flatMap(attribute), ({ agent }) => agent))
    .map((members) =>
      AgentModelsView.make({
        agent: members[0].agent,
        tasks: members.length,
        opened: members.filter(({ opened }) => opened).length,
        models: Object.values(
          EffectArray.groupBy(members, ({ harness, model }) => jsonKey([harness, model])),
        )
          .map(modelOutcome)
          .sort(
            (left, right) =>
              right.tasks - left.tasks ||
              left.harness.localeCompare(right.harness) ||
              left.model.localeCompare(right.model),
          ),
      }),
    )
    .sort(
      (left, right) =>
        right.opened - left.opened ||
        right.tasks - left.tasks ||
        left.agent.localeCompare(right.agent),
    );
