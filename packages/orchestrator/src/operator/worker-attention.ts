import { WORKER_UNRESPONSIVE_PROBES } from "@usine/core/attempt/channel";
import type { WorkerName } from "@usine/core/worker";
import type { AttentionAcknowledgements } from "@usine/engine/attention";
import type { RunReader } from "@usine/engine/run-reader";
import { TranscriptWorkerQuery } from "@usine/engine/transcript";
import { DateTime, Effect, Option } from "effect";
import { partitionNeeds, projectAttention } from "./attention.ts";
import {
  type NeedView,
  UnresponsiveWorkerNeed,
  WorkerPreflightNeed,
  WorkerQuotaNeed,
} from "./need.ts";
import { ReadyOverview } from "./overview.ts";
import type { WorkerStatus } from "../worker-status.ts";
import type { AttemptSummaryView } from "./attempt.ts";
import type { RunSummaryView } from "./run.ts";

export const workerAttentionFor = (
  reader: Pick<RunReader["Service"], "transcript">,
  acknowledgements: Pick<AttentionAcknowledgements["Service"], "list">,
  status: Pick<WorkerStatus["Service"], "unavailable" | "provisioning">,
) =>
  Effect.fn("Operator.workerAttention")(function* (
    overview: ReadyOverview,
    running: ReadonlyArray<
      Pick<RunSummaryView, "id" | "repository" | "loop"> & {
        readonly attempts: ReadonlyArray<
          Pick<AttemptSummaryView, "id" | "worker" | "number" | "outcome">
        >;
      }
    >,
    declared: ReadonlyArray<WorkerName>,
  ) {
    const silent = yield* Effect.forEach(
      running.flatMap((run) =>
        run.attempts
          .filter((attempt) => attempt.outcome === null)
          .map((attempt) => ({ run, attempt })),
      ),
      Effect.fn("Operator.workerAttention.attempt")(function* ({ run, attempt }) {
        yield* Effect.annotateCurrentSpan({
          runId: run.id,
          attemptId: attempt.id,
          worker: attempt.worker,
        });
        const entries = yield* reader.transcript(
          TranscriptWorkerQuery.make({ attemptId: attempt.id }),
        );
        const notice = entries.at(-1)?.envelope.payload;
        return notice?._tag === "WorkerUnresponsive" &&
          notice.unansweredProbes >= WORKER_UNRESPONSIVE_PROBES
          ? [{ run, attempt, notice }]
          : [];
      }),
      { concurrency: 4 },
    );
    const workers = new Map<WorkerName, UnresponsiveWorkerNeed>();
    for (const { run, attempt, notice } of silent.flat()) {
      const previous = workers.get(notice.worker);
      const lastAnsweredAt = DateTime.formatIso(notice.lastAnsweredAt);
      workers.set(
        notice.worker,
        UnresponsiveWorkerNeed.make({
          id: `unresponsive-worker:${notice.worker}`,
          worker: notice.worker,
          lastAnsweredAt:
            previous !== undefined && previous.lastAnsweredAt < lastAnsweredAt
              ? previous.lastAnsweredAt
              : lastAnsweredAt,
          attempts: [
            ...(previous?.attempts ?? []),
            {
              attemptId: attempt.id,
              attemptNumber: attempt.number,
              runId: run.id,
              repository: run.repository,
              loop: run.loop,
            },
          ],
        }),
      );
    }
    yield* Effect.logDebug("Read worker responsiveness", {
      workers: [...workers.keys()],
      affectedAttempts: silent.flat().length,
    });
    const needs: Array<NeedView> = [...workers.values()];
    for (const { worker, message } of yield* status.unavailable) {
      if (!declared.includes(worker)) continue;
      needs.push(WorkerPreflightNeed.make({ id: `worker-preflight:${worker}`, worker, message }));
    }
    for (const { worker, quota } of yield* status.provisioning) {
      if (declared.includes(worker) && Option.isSome(quota))
        needs.push(
          WorkerQuotaNeed.make({ id: `worker-quota:${worker}`, worker, message: quota.value }),
        );
    }
    if (needs.length === 0) return overview;
    const storedAcknowledgements = yield* acknowledgements.list;
    const { needsYou, dismissedNeeds } = partitionNeeds(needs, storedAcknowledgements);
    const visible = [...overview.needsYou, ...needsYou];
    yield* Effect.logDebug("Refreshed worker attention", {
      workers: [...workers.keys()],
      attempts: silent.flat().length,
      dismissed: dismissedNeeds.length,
      quotaRefusals: needs.filter((need) => need._tag === "WorkerQuotaNeed").length,
      preflightFailures: needs.filter((need) => need._tag === "WorkerPreflightNeed").length,
    });
    return ReadyOverview.make({
      ...overview,
      projects: projectAttention(overview.projects, visible),
      needsYou: visible,
      dismissedNeeds: [...overview.dismissedNeeds, ...dismissedNeeds],
    });
  });
