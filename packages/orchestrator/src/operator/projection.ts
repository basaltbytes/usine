import type { Worker as ConfigWorker } from "@usine/config/factory";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { AttemptOutcome } from "@usine/core/attempt/outcome";
import { LoopName } from "@usine/core/loop";
import * as RunState from "@usine/core/run/state";
import { PullRequest } from "@usine/core/step/result";
import { SshDestination, type WorkerName } from "@usine/core/worker";
import { type RunSnapshot, type RunSummary, RunReader } from "@usine/engine/run-reader";
import type { RunStoreError } from "@usine/engine/engine";
import {
  type TranscriptEntry,
  TranscriptPageQuery,
  TranscriptTailQuery,
} from "@usine/engine/transcript";
import { DateTime, Effect, Match, Option } from "effect";
import {
  AgentFailureView,
  AttemptView,
  BlockedFailureView,
  CanceledAttemptView,
  ChildSessionBudgetFailureView,
  DefectFailureView,
  FailedAttemptView,
  type FailureView,
  InfraFailureView,
  LocalWorkerAccess,
  QuestionFailureView,
  RunawayFailureView,
  SshWorkerAccess,
  SucceededAttemptView,
  type WorkerAccess,
} from "./attempt.ts";
import {
  FailedTranscriptView,
  type TranscriptRequest,
  TranscriptAttemptNotFoundError,
  TranscriptPageCursor,
  TranscriptEventView,
} from "./transcript.ts";
import { ApprovalView, RunDurationView, RunView } from "./run.ts";

/** The number of newest rows loaded per Attempt when a drawer opens. */
const COLD_TRANSCRIPT_LIMIT = 500;
/** The maximum rows in one live catch-up response across all Attempts. */
const TAIL_TRANSCRIPT_LIMIT = 500;

export const failureView = (failure: AttemptFailure): FailureView =>
  Match.valueTags(failure, {
    InfraFailure: ({ message }) => new InfraFailureView({ message }),
    DefectFailure: ({ message }) => new DefectFailureView({ message }),
    AgentFailure: ({ message }) => new AgentFailureView({ message }),
    BlockedFailure: ({ message }) => new BlockedFailureView({ message }),
    QuestionFailure: ({ question }) => new QuestionFailureView({ question }),
    RunawayFailure: ({ ceiling }) => new RunawayFailureView({ ceiling }),
    ChildSessionBudgetFailure: ({ attemptedChildren, maxChildren }) =>
      new ChildSessionBudgetFailureView({ attemptedChildren, maxChildren }),
  });

const attemptOutcomeView = (outcome: AttemptOutcome) =>
  Match.valueTags(outcome, {
    Succeeded: () => new SucceededAttemptView(),
    Failed: ({ failure }) => new FailedAttemptView({ failure: failureView(failure) }),
    Canceled: () => new CanceledAttemptView(),
  });

/** How the operator accesses each Worker declared in `usine.yaml`, by name. */
export type WorkerAccesses = ReadonlyMap<WorkerName, WorkerAccess>;

const workerAccess = (worker: ConfigWorker): WorkerAccess => {
  switch (worker.kind) {
    case "local":
      return new LocalWorkerAccess();
    case "ssh":
      return new SshWorkerAccess({
        destination: worker.destination,
        port: Option.getOrNull(worker.port),
      });
    case "exe.dev":
      // exe.dev names the VM after the Worker and serves it at `<vm>.exe.xyz` on the default port;
      // `usine.yaml` has no address for it.
      return new SshWorkerAccess({
        destination: SshDestination.make(`${worker.name}.exe.xyz`),
        port: null,
      });
  }
};

/** Returns how the operator accesses each of `workers`. */
export const workerAccesses = (workers: ReadonlyArray<ConfigWorker>): WorkerAccesses =>
  new Map(workers.map((worker) => [worker.name, workerAccess(worker)]));

const attemptView = (
  attempt: RunSnapshot["attempts"][number],
  workers: WorkerAccesses,
): AttemptView => {
  return new AttemptView({
    id: attempt.id,
    number: attempt.number,
    worker: attempt.worker,
    workerAccess: workers.get(attempt.worker) ?? null,
    brain: attempt.brain,
    task: attempt.task,
    agent: attempt.agent,
    operatorIntervened: attempt.operatorIntervened,
    startedAt: DateTime.formatIso(attempt.startedAt),
    outcome: Option.match(attempt.outcome, {
      onNone: () => null,
      onSome: attemptOutcomeView,
    }),
    endedAt: Option.match(attempt.endedAt, { onNone: () => null, onSome: DateTime.formatIso }),
    salvage: Option.getOrNull(attempt.salvage),
    start: Option.getOrNull(attempt.start),
    reattachedAt: Option.match(attempt.reattachedAt, {
      onNone: () => null,
      onSome: DateTime.formatIso,
    }),
  });
};

/**
 * Returns the time a Run's Attempts worked, with the open Attempt's start in `runningSince`. An
 * Attempt with no recorded end ends at its newest transcript row from `lastRows`.
 */
export const runDuration = (
  attempts: RunSnapshot["attempts"],
  lastRows: ReadonlyMap<RunSnapshot["attempts"][number]["id"], DateTime.Utc>,
): RunDurationView => {
  let endedMillis = 0;
  let unmeasured = 0;
  let runningSince: string | null = null;
  for (const attempt of attempts) {
    if (Option.isNone(attempt.outcome)) {
      runningSince = DateTime.formatIso(attempt.startedAt);
      continue;
    }
    Option.match(
      Option.orElse(attempt.endedAt, () => Option.fromNullishOr(lastRows.get(attempt.id))),
      {
        onNone: () => {
          unmeasured += 1;
        },
        onSome: (endedAt) => {
          endedMillis += Math.max(
            0,
            DateTime.toEpochMillis(endedAt) - DateTime.toEpochMillis(attempt.startedAt),
          );
        },
      },
    );
  }
  return new RunDurationView({ endedMillis, runningSince, unmeasured });
};

/** Reads the newest transcript row time of each closed Attempt with no recorded end. */
export const readUnrecordedEnds = Effect.fn("Operator.readUnrecordedEnds")(function* (
  runs: RunReader["Service"],
  snapshot: RunSnapshot,
) {
  const unrecorded = snapshot.attempts.filter(
    (attempt) => Option.isSome(attempt.outcome) && Option.isNone(attempt.endedAt),
  );
  const newest = yield* Effect.forEach(
    unrecorded,
    (attempt) =>
      runs
        .transcript(
          new TranscriptPageQuery({ attemptId: attempt.id, before: Option.none(), limit: 1 }),
        )
        .pipe(Effect.map((rows) => [attempt.id, rows.at(-1)?.receivedAt] as const)),
    { concurrency: 4 },
  );
  return new Map(
    newest.flatMap(([attemptId, receivedAt]) =>
      receivedAt === undefined ? [] : [[attemptId, receivedAt] as const],
    ),
  );
});

/** Reads the Event of each running Run in `summaries`, by Run, for `projectBoard`. */
export const readRunningEvents = Effect.fn("Operator.readRunningEvents")(function* (
  runs: RunReader["Service"],
  summaries: ReadonlyArray<RunSummary>,
) {
  const running = summaries.flatMap(({ run }) => (run.state._tag === "Running" ? [run.id] : []));
  const read = yield* runs.events(running);
  yield* Effect.logDebug("Read the Events of the running Runs", {
    running: running.length,
    events: read.length,
  });
  return new Map(read.map(({ runId, event }) => [runId, event] as const));
});

/**
 * Returns the operator's view of a saved Run. `pausedLoops` gives the paused Loops and `workers`
 * how each Attempt's Worker is accessed.
 */
export const runView = (
  snapshot: RunSummary,
  pausedLoops: ReadonlySet<LoopName>,
  workers: WorkerAccesses,
): RunView => {
  const actions = RunState.operatorActions(snapshot.run.state);
  const result = Option.getOrNull(snapshot.step.result);
  const pullRequest = result?.facts.find(
    (fact): fact is PullRequest => fact._tag === "PullRequest",
  );
  return new RunView({
    id: snapshot.run.id,
    itemKey: snapshot.itemKey,
    loop: snapshot.run.loop,
    repository: snapshot.repository,
    agent: snapshot.agent.name,
    state: snapshot.run.state._tag,
    loopPaused: pausedLoops.has(snapshot.run.loop),
    openedAt: DateTime.formatIso(snapshot.run.openedAt),
    closedAt: Option.match(snapshot.closedAt, { onNone: () => null, onSome: DateTime.formatIso }),
    task: snapshot.task,
    attempts: snapshot.attempts.map((attempt) => attemptView(attempt, workers)),
    approval: Option.match(snapshot.approval, {
      onNone: () => null,
      onSome: ({ approvedAt, source }) =>
        new ApprovalView({
          approvedAt: DateTime.formatIso(approvedAt),
          source: Option.getOrNull(source),
        }),
    }),
    runAgain: Option.getOrNull(snapshot.runAgain),
    resultMessage: result?.message ?? null,
    pullRequestUrl: pullRequest?.url.toString() ?? null,
    ...actions,
    canResolveFailure:
      actions.canResolveFailure &&
      !Option.contains(snapshot.resolvedFailureAttemptId, snapshot.attempts.at(-1)?.id),
  });
};

const transcriptPayload = (
  payload: AttemptChannel.OutboundPayload | AttemptChannel.InboundPayload,
) =>
  Match.valueTags(payload, {
    Started: (value) => value,
    SessionEvent: (value) => value,
    Final: (value) => value,
    Failed: ({ failure }) => new FailedTranscriptView({ failure: failureView(failure) }),
    Interrupted: (value) => value,
    Steer: (value) => value,
    Interrupt: (value) => value,
    OperatorMessage: (value) => value,
    Release: (value) => value,
    Cancel: (value) => value,
    InterventionApplied: (value) => value,
    InterventionRejected: (value) => value,
    WorkerUnresponsive: (value) => value,
    WorkerResponsive: (value) => value,
  });

/** Returns the view of one transcript row, with attribution and without private failure causes. */
export const transcriptEvent = (entry: TranscriptEntry): TranscriptEventView => {
  const fields = {
    sequence: entry.sequence,
    attemptId: entry.attemptId,
    receivedAt: DateTime.formatIso(entry.receivedAt),
    direction: entry.direction,
    payload: transcriptPayload(entry.envelope.payload),
  };
  if (entry.envelope._tag === "InboundEnvelope" && "target" in entry.envelope) {
    return new TranscriptEventView({
      ...fields,
      target: entry.envelope.target,
      operator: entry.envelope.operator,
    });
  }
  return new TranscriptEventView(fields);
};

interface TranscriptRead {
  readonly events: ReadonlyArray<TranscriptEventView>;
  readonly earlier: ReadonlyArray<TranscriptPageCursor>;
}

const sortedEvents = (
  entries: ReadonlyArray<TranscriptEntry>,
): ReadonlyArray<TranscriptEventView> =>
  [...entries].sort((left, right) => left.sequence - right.sequence).map(transcriptEvent);

const readPage = Effect.fn("Operator.readTranscriptPage")(function* (
  runs: RunReader["Service"],
  attemptId: RunSnapshot["attempts"][number]["id"],
  before: Option.Option<TranscriptPageCursor["before"]>,
) {
  yield* Effect.annotateCurrentSpan({
    attemptId,
    before: Option.getOrNull(before),
  });
  const entries = yield* runs.transcript(
    new TranscriptPageQuery({
      attemptId,
      before,
      limit: COLD_TRANSCRIPT_LIMIT + 1,
    }),
  );
  const hasEarlier = entries.length > COLD_TRANSCRIPT_LIMIT;
  const visible = hasEarlier ? entries.slice(1) : entries;
  const first = visible[0];
  yield* Effect.logDebug("Read operator transcript page", {
    attemptId,
    before: Option.getOrNull(before),
    returned: visible.length,
    hasEarlier,
  });
  return {
    events: sortedEvents(visible),
    earlier:
      hasEarlier && first !== undefined
        ? [new TranscriptPageCursor({ attemptId, before: first.sequence })]
        : [],
  };
});

export const readTranscript: (
  runs: RunReader["Service"],
  snapshot: RunSnapshot,
  request: TranscriptRequest,
) => Effect.Effect<TranscriptRead, RunStoreError | TranscriptAttemptNotFoundError> = Effect.fn(
  "Operator.readTranscript",
)(function* (runs: RunReader["Service"], snapshot: RunSnapshot, request: TranscriptRequest) {
  yield* Effect.annotateCurrentSpan({ runId: snapshot.run.id, request: request._tag });
  const read = yield* Match.valueTags(request, {
    ColdTranscriptRequest: () =>
      Effect.forEach(snapshot.attempts, (attempt) => readPage(runs, attempt.id, Option.none()), {
        concurrency: 4,
      }).pipe(
        Effect.map((pages) => ({
          events: pages
            .flatMap(({ events }) => events)
            .sort((left, right) => left.sequence - right.sequence),
          earlier: pages.flatMap(({ earlier }) => earlier),
        })),
      ),
    TailTranscriptRequest: ({ after }) =>
      Effect.forEach(
        snapshot.attempts,
        (attempt) =>
          runs.transcript(
            new TranscriptTailQuery({
              attemptId: attempt.id,
              after,
              limit: TAIL_TRANSCRIPT_LIMIT,
            }),
          ),
        { concurrency: 4 },
      ).pipe(
        Effect.map((entries) => ({
          events: sortedEvents(entries.flat()).slice(0, TAIL_TRANSCRIPT_LIMIT),
          earlier: [],
        })),
      ),
    EarlierTranscriptRequest: ({ attemptId, before }) => {
      if (!snapshot.attempts.some((attempt) => attempt.id === attemptId)) {
        return new TranscriptAttemptNotFoundError({ runId: snapshot.run.id, attemptId });
      }
      return readPage(runs, attemptId, Option.some(before));
    },
  });
  yield* Effect.logDebug("Read operator transcript", {
    runId: snapshot.run.id,
    request: request._tag,
    events: read.events.length,
    earlier: read.earlier.length,
  });
  return read;
});
