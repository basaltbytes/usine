import { InstanceScope } from "@usine/core/access";
import type { ChangeAudience } from "@usine/core/changes";
import type { PoolRateLimitsUpdated } from "@usine/core/agent/session";
import {
  AttentionKey,
  AttentionRevision,
  type AttentionAcknowledgements,
} from "@usine/engine/attention";
import type { RunReader } from "@usine/engine/run-reader";
import { DateTime, Effect, Match, Option, Schema } from "effect";
import {
  boardTaskRuns,
  BoardTaskView,
  BoardView,
  ReadOnlyBoardLaneView,
  WritableBoardLaneView,
} from "./board.ts";
import { NeedView, PoolLimitNeed, POOL_LIMIT_WARNING_PERCENT } from "./need.ts";
import type { RunSummaryView } from "./run.ts";
import { ProjectView, ReadyOverview } from "./overview.ts";

// Pure serializers and synchronous callbacks return JSON values directly.
// @effect-diagnostics-next-line schemaSync:off
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// The need is already validated; attention keys are derived synchronously.
// @effect-diagnostics-next-line schemaSync:off
const encodeNeed = Schema.encodeSync(NeedView);

/** Identifies the condition to dismiss; pool usage is grouped into threshold bands. */
export const attentionKey = (need: NeedView): AttentionKey => {
  const content =
    need._tag === "PoolLimitNeed"
      ? {
          pool: need.pool,
          window: need.window,
          resetsAt: DateTime.formatIso(need.resetsAt),
          band: [90, 95, 100].reduce(
            (band, threshold) => (need.usedPercent >= threshold ? threshold : band),
            POOL_LIMIT_WARNING_PERCENT,
          ),
        }
      : encodeNeed(need);
  return AttentionKey.make({
    id: need.id,
    revision: AttentionRevision.make(stringifyJson(content)),
  });
};

export const needRepositories = (need: NeedView) =>
  Match.valueTags(need, {
    ApprovalNeed: ({ repository }) => [repository],
    RunFailureNeed: ({ repository }) => [repository],
    UnconfirmedStopNeed: ({ repository }) => [repository],
    CycleBudgetNeed: ({ ask }) => [ask.repository],
    BoardProjectionNeed: ({ failure }) => [failure.repository],
    PollFailureNeed: ({ failure }) => [failure.repository],
    PreflightFindingNeed: ({ finding }) => [finding.repository],
    ScheduleFailureNeed: ({ failure }) =>
      failure._tag === "ScheduleTickFailure" ? [failure.repository] : [],
    ConfigFileNeed: () => [],
    UnconfiguredWorkerNeed: () => [],
    WorkerPreflightNeed: () => [],
    WorkerQuotaNeed: () => [],
    PoolLimitNeed: () => [],
    WebhookSilenceNeed: () => [],
    UpgradeDrainNeed: () => [],
    UnresponsiveWorkerNeed: ({ attempts }) => attempts.map(({ repository }) => repository),
  });

export const taskNeedsAttention = (
  task: {
    readonly items: ReadonlyArray<Pick<BoardTaskView["items"][number], "itemKey">>;
    readonly runs: ReadonlyArray<Pick<RunSummaryView, "id">>;
  },
  needs: ReadonlyArray<NeedView>,
): boolean =>
  needs.some((need) => {
    if (need._tag === "UnresponsiveWorkerNeed")
      return need.attempts.some(({ runId }) => task.runs.some(({ id }) => id === runId));
    if ("runId" in need) return task.runs.some(({ id }) => id === need.runId);
    if (need._tag === "CycleBudgetNeed")
      return task.items.some(({ itemKey }) => itemKey === need.ask.itemKey);
    if (need._tag === "BoardProjectionNeed")
      return task.items.some(({ itemKey }) => itemKey === need.failure.itemKey);
    return false;
  });

/** Keeps all attention badges consistent with the visible entries, preserving run actions. */
export const projectAttention = (
  projects: ReadonlyArray<ProjectView>,
  needsYou: ReadonlyArray<NeedView>,
): ReadonlyArray<ProjectView> => {
  const repositories = new Set(needsYou.flatMap(needRepositories));
  return projects.map((project) =>
    ProjectView.make({
      ...project,
      status: [project.repository, ...project.repositories].some((name) => repositories.has(name))
        ? "needs-you"
        : project.runs.some(({ canCancel }) => canCancel)
          ? "active"
          : "clear",
      board: BoardView.make({
        ...project.board,
        lanes: project.board.lanes.map((lane) => {
          const items = lane.items.map((task) =>
            BoardTaskView.make({
              ...task,
              needsYou: taskNeedsAttention(
                { items: task.items, runs: boardTaskRuns(task) },
                needsYou,
              ),
            }),
          );
          return lane._tag === "WritableBoardLane"
            ? WritableBoardLaneView.make({ ...lane, items })
            : ReadOnlyBoardLaneView.make({ ...lane, items });
        }),
      }),
    }),
  );
};

export const partitionNeeds = (
  needs: ReadonlyArray<NeedView>,
  acknowledgements: ReadonlyArray<Pick<AttentionKey, "id" | "revision">>,
) => {
  const dismissed = new Set(
    acknowledgements.map(({ id, revision }) => stringifyJson([id, revision])),
  );
  const needsYou: Array<NeedView> = [];
  const dismissedNeeds: Array<NeedView> = [];
  for (const need of needs) {
    const { id, revision } = attentionKey(need);
    (dismissed.has(stringifyJson([id, revision])) ? dismissedNeeds : needsYou).push(need);
  }
  return { needsYou, dismissedNeeds };
};

export const poolLimitNeeds = (
  snapshots: ReadonlyArray<PoolRateLimitsUpdated>,
  now: DateTime.Utc,
): ReadonlyArray<PoolLimitNeed> =>
  snapshots.flatMap(({ pool, login, rateLimits }) =>
    (["primary", "secondary"] as const).flatMap((window) => {
      const limit = rateLimits[window];
      if (Option.isNone(limit) || limit.value.usedPercent < POOL_LIMIT_WARNING_PERCENT) return [];
      const { usedPercent, resetsAt } = limit.value;
      if (Option.isNone(resetsAt) || !DateTime.isGreaterThan(resetsAt.value, now)) return [];
      return [
        PoolLimitNeed.make({
          id: `pool-limit:${pool}:${window}`,
          pool,
          login,
          window,
          usedPercent,
          resetsAt: resetsAt.value,
        }),
      ];
    }),
  );

export const poolAttentionFor = (
  reader: Pick<RunReader["Service"], "latestPoolRateLimits">,
  acknowledgements: Pick<AttentionAcknowledgements["Service"], "list">,
) =>
  Effect.fn("Operator.poolAttention")(function* (overview: ReadyOverview) {
    const snapshots = yield* reader.latestPoolRateLimits;
    yield* Effect.annotateCurrentSpan({ pools: snapshots.map(({ pool }) => pool) });
    const observedAt = yield* DateTime.now;
    const needs = poolLimitNeeds(snapshots, observedAt);
    yield* Effect.logDebug("Refreshed pool attention", {
      snapshots: snapshots.map(({ pool, rateLimits: { primary, secondary } }) => ({
        pool,
        primary,
        secondary,
      })),
      activeWindows: needs.length,
    });
    if (needs.length === 0) return overview;
    const storedAcknowledgements = yield* acknowledgements.list;
    const { needsYou, dismissedNeeds } = partitionNeeds(needs, storedAcknowledgements);
    return ReadyOverview.make({
      ...overview,
      needsYou: [...overview.needsYou, ...needsYou],
      dismissedNeeds: [...overview.dismissedNeeds, ...dismissedNeeds],
    });
  });

/** Uses the validated attention revision to scope dismissal notices like the displayed entry. */
export const attentionAudiences = (key: AttentionKey): ReadonlyArray<ChangeAudience> => {
  const need = Schema.decodeOption(Schema.fromJsonString(NeedView))(key.revision);
  if (Option.isNone(need)) return [InstanceScope.make()];
  const repositories = needRepositories(need.value);
  return repositories.length === 0
    ? [InstanceScope.make()]
    : repositories.map((repository) => ({ _tag: "Repository", repository }));
};
