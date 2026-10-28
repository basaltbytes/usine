import { WORKER_UNRESPONSIVE_PROBES } from "@usine/core/attempt/channel";
import type { WorkerName } from "@usine/core/worker";
import type { AttentionAcknowledgements } from "@usine/engine/attention";
import type { RunReader } from "@usine/engine/run-reader";
import { TranscriptWorkerQuery } from "@usine/engine/transcript";
import { DateTime, Effect } from "effect";
import { partitionNeeds, projectAttention } from "./attention.ts";
import { UnresponsiveWorkerNeed } from "./need.ts";
import { ReadyOverview } from "./overview.ts";
import type { RunView } from "./run.ts";

export const workerAttentionFor = (
  reader: Pick<RunReader["Service"], "transcript">,
  acknowledgements: Pick<AttentionAcknowledgements["Service"], "list">,
) =>
  Effect.fn("Operator.workerAttention")(function* (
    overview: ReadyOverview,
    running: ReadonlyArray<RunView>,
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
          new TranscriptWorkerQuery({ attemptId: attempt.id }),
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
        new UnresponsiveWorkerNeed({
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
    if (workers.size === 0) return overview;
    const { needsYou, dismissedNeeds } = partitionNeeds(
      [...workers.values()],
      yield* acknowledgements.list(),
    );
    const visible = [...overview.needsYou, ...needsYou];
    yield* Effect.logDebug("Refreshed unresponsive worker attention", {
      workers: [...workers.keys()],
      attempts: silent.flat().length,
      dismissed: dismissedNeeds.length,
    });
    return new ReadyOverview({
      ...overview,
      projects: projectAttention(overview.projects, visible),
      needsYou: visible,
      dismissedNeeds: [...overview.dismissedNeeds, ...dismissedNeeds],
    });
  });
