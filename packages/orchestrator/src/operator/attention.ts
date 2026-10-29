import type { PoolRateLimitsUpdated } from "@usine/core/agent/session";
import {
  AttentionKey,
  AttentionRevision,
  type AttentionAcknowledgements,
} from "@usine/engine/attention";
import type { RunReader } from "@usine/engine/run-reader";
import { DateTime, Effect, Match, Option, Schema } from "effect";
import { BoardTaskView, BoardView, ReadOnlyBoardLaneView, WritableBoardLaneView } from "./board.ts";
import { NeedView, PoolLimitNeed, POOL_LIMIT_WARNING_PERCENT } from "./need.ts";
import { ProjectView, ReadyOverview } from "./overview.ts";

const encodeNeed = Schema.encodeSync(NeedView);

/** Identifies the displayed content, including counts and failure details. */
export const attentionKey = (need: NeedView): AttentionKey =>
  new AttentionKey({
    id: need.id,
    revision: AttentionRevision.make(JSON.stringify(encodeNeed(need))),
  });

const repositoriesOf = (need: NeedView) =>
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
    PoolLimitNeed: () => [],
    WebhookSilenceNeed: () => [],
    UnresponsiveWorkerNeed: ({ attempts }) => attempts.map(({ repository }) => repository),
  });

export const taskNeedsAttention = (
  task: Pick<BoardTaskView, "items" | "runs">,
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
  const repositories = new Set(needsYou.flatMap(repositoriesOf));
  return projects.map(
    (project) =>
      new ProjectView({
        ...project,
        status: [project.repository, ...project.repositories].some((name) => repositories.has(name))
          ? "needs-you"
          : project.runs.some(({ canCancel }) => canCancel)
            ? "active"
            : "clear",
        board: new BoardView({
          ...project.board,
          lanes: project.board.lanes.map((lane) => {
            const items = lane.items.map(
              (task) =>
                new BoardTaskView({ ...task, needsYou: taskNeedsAttention(task, needsYou) }),
            );
            return lane._tag === "WritableBoardLane"
              ? new WritableBoardLaneView({ ...lane, items })
              : new ReadOnlyBoardLaneView({ ...lane, items });
          }),
        }),
      }),
  );
};

export const partitionNeeds = (
  needs: ReadonlyArray<NeedView>,
  acknowledgements: ReadonlyArray<AttentionKey>,
) => {
  const dismissed = new Set(
    acknowledgements.map(({ id, revision }) => JSON.stringify([id, revision])),
  );
  const needsYou: Array<NeedView> = [];
  const dismissedNeeds: Array<NeedView> = [];
  for (const need of needs) {
    const { id, revision } = attentionKey(need);
    (dismissed.has(JSON.stringify([id, revision])) ? dismissedNeeds : needsYou).push(need);
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
        new PoolLimitNeed({
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
    const snapshots = yield* reader.latestPoolRateLimits();
    yield* Effect.annotateCurrentSpan({ pools: snapshots.map(({ pool }) => pool) });
    const needs = poolLimitNeeds(snapshots, yield* DateTime.now);
    yield* Effect.logDebug("Refreshed pool attention", {
      snapshots: snapshots.map(({ pool, rateLimits: { primary, secondary } }) => ({
        pool,
        primary,
        secondary,
      })),
      activeWindows: needs.length,
    });
    if (needs.length === 0) return overview;
    const { needsYou, dismissedNeeds } = partitionNeeds(needs, yield* acknowledgements.list());
    return new ReadyOverview({
      ...overview,
      needsYou: [...overview.needsYou, ...needsYou],
      dismissedNeeds: [...overview.dismissedNeeds, ...dismissedNeeds],
    });
  });
