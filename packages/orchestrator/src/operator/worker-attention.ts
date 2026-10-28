import { WORKER_ATTENTION_PROBES } from "@usine/core/attempt/channel";
import type { WorkerName } from "@usine/core/worker";
import type { RunReader, RunSummary } from "@usine/engine/run-reader";
import { TranscriptWorkerQuery } from "@usine/engine/transcript";
import { DateTime, Effect, Option } from "effect";
import { WorkerUnresponsiveNeed } from "./need.ts";

export const workerAttention = Effect.fn("Operator.workerAttention")(function* (
  reader: Pick<RunReader["Service"], "transcript">,
  runs: ReadonlyArray<RunSummary>,
) {
  const attempts = runs.flatMap((run) =>
    run.attempts
      .filter((attempt) => Option.isNone(attempt.outcome))
      .map((attempt) => ({ run, attempt })),
  );
  yield* Effect.annotateCurrentSpan({ attemptIds: attempts.map(({ attempt }) => attempt.id) });
  const notices = yield* Effect.forEach(
    attempts,
    ({ attempt }) =>
      reader
        .transcript(new TranscriptWorkerQuery({ attemptId: attempt.id }))
        .pipe(
          Effect.map((entries) =>
            entries.filter(
              (entry) =>
                Option.isNone(attempt.reattachedAt) ||
                DateTime.toEpochMillis(entry.receivedAt) >=
                  DateTime.toEpochMillis(attempt.reattachedAt.value),
            ),
          ),
        ),
    { concurrency: 4 },
  );
  const silent = new Map<WorkerName, string>();
  for (const entry of notices.flat()) {
    const notice = entry.envelope.payload;
    if (notice._tag !== "WorkerUnresponsive" || notice.unansweredProbes < WORKER_ATTENTION_PROBES)
      continue;
    const at = DateTime.formatIso(notice.lastAnsweredAt);
    const previous = silent.get(notice.worker);
    if (previous === undefined || at < previous) silent.set(notice.worker, at);
  }
  const needs: Array<WorkerUnresponsiveNeed> = [];
  for (const [worker, lastAnsweredAt] of silent) {
    const affected = attempts
      .filter(({ attempt }) => attempt.worker === worker)
      .map(({ run, attempt }) => ({
        attemptId: attempt.id,
        attemptNumber: attempt.number,
        runId: run.run.id,
        repository: run.repository,
        loop: run.run.loop,
      }));
    const [first, ...rest] = affected;
    if (first !== undefined)
      needs.push(
        new WorkerUnresponsiveNeed({
          id: `worker-unresponsive:${worker}`,
          worker,
          lastAnsweredAt,
          attempts: [first, ...rest],
        }),
      );
  }
  yield* Effect.logDebug("Worker attention read", {
    runningAttempts: attempts.length,
    unresponsiveWorkers: needs.map(({ worker }) => worker),
  });
  return needs;
});
