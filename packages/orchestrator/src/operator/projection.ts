import type { RunId } from "@usine/core/run";
import { pendingProviderRetry } from "@usine/core/attempt";
import type { Worker as ConfigWorker } from "@usine/config/factory";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { AttemptOutcome } from "@usine/core/attempt/outcome";
import { LoopName } from "@usine/core/loop";
import * as RunState from "@usine/core/run/state";
import { SshDestination, type WorkerName } from "@usine/core/worker";
import {
  type RunSnapshot,
  type RunSummary,
  RunReader,
  summarizeRun,
} from "@usine/engine/run-reader";
import type { UpgradeDrain, RunStoreError } from "@usine/engine/engine";
import {
  type TranscriptEntry,
  TranscriptPageQuery,
  TranscriptTailQuery,
} from "@usine/engine/transcript";
import { DateTime, Effect, Match, Option } from "effect";
import {
  AgentFailureView,
  AttemptSummaryView,
  AttemptView,
  AwaitingCiAttemptView,
  HandedOffAttemptView,
  BlockedFailureView,
  CanceledAttemptView,
  ChildSessionBudgetFailureView,
  DefectFailureView,
  FailedAttemptView,
  type FailureView,
  InfraFailureView,
  ProviderCapacityFailureView,
  GitHubPushFailureView,
  LocalWorkerAccess,
  QuestionFailureView,
  RunawayFailureView,
  ProvisionedWorkerAccess,
  SandboxWorkerAccess,
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
import type { MachineQuotaWait } from "./machines.ts";
import { ApprovalView, RunDurationView, RunSummaryView, RunView } from "./run.ts";

/** The number of newest rows loaded per Attempt when a drawer opens. */
const COLD_TRANSCRIPT_LIMIT = 500;
/** The maximum rows in one live catch-up response across all Attempts. */
const TAIL_TRANSCRIPT_LIMIT = 500;

export const failureView = (failure: AttemptFailure): FailureView =>
  Match.valueTags(failure, {
    GitHubPushFailure: ({ message }) => GitHubPushFailureView.make({ message }),
    InfraFailure: ({ message }) => InfraFailureView.make({ message }),
    ProviderCapacityFailure: ({ message }) => ProviderCapacityFailureView.make({ message }),
    DefectFailure: ({ message }) => DefectFailureView.make({ message }),
    AgentFailure: ({ message }) => AgentFailureView.make({ message }),
    BlockedFailure: ({ message }) => BlockedFailureView.make({ message }),
    QuestionFailure: ({ question }) => QuestionFailureView.make({ question }),
    RunawayFailure: ({ ceiling }) => RunawayFailureView.make({ ceiling }),
    ChildSessionBudgetFailure: ({ attemptedChildren, maxChildren }) =>
      ChildSessionBudgetFailureView.make({ attemptedChildren, maxChildren }),
  });

const attemptOutcomeView = (outcome: AttemptOutcome) =>
  Match.valueTags(outcome, {
    Succeeded: () => SucceededAttemptView.make(),
    AwaitingCi: () => AwaitingCiAttemptView.make(),
    HandedOff: () => HandedOffAttemptView.make(),
    Failed: ({ failure }) => FailedAttemptView.make({ failure: failureView(failure) }),
    Canceled: () => CanceledAttemptView.make(),
  });

/** How the operator accesses each Worker declared in `usine.yaml`, by name. */
export type WorkerAccesses = ReadonlyMap<WorkerName, WorkerAccess>;

const workerAccess = (worker: ConfigWorker): WorkerAccess => {
  switch (worker.kind) {
    case "local":
      return LocalWorkerAccess.make();
    case "ssh":
      // `usine.yaml` sets a destination for every SSH Worker without a provisioner.
      return Option.match(worker.provisioner, {
        onSome: ({ provider }) => ProvisionedWorkerAccess.make({ provider }),
        onNone: () =>
          SshWorkerAccess.make({
            destination: Option.getOrElse(worker.destination, () =>
              SshDestination.make(worker.name),
            ),
            port: Option.getOrNull(worker.port),
          }),
      });
    case "exe.dev":
      // exe.dev names the VM after the Worker and serves it at `<vm>.exe.xyz` on the default port;
      // `usine.yaml` has no address for it.
      return SshWorkerAccess.make({
        destination: SshDestination.make(`${worker.name}.exe.xyz`),
        port: null,
      });
    case "cloudflare":
      return SandboxWorkerAccess.make();
  }
};

/** Returns how the operator accesses each of `workers`. */
export const workerAccesses = (workers: ReadonlyArray<ConfigWorker>): WorkerAccesses =>
  new Map(workers.map((worker) => [worker.name, workerAccess(worker)]));

const attemptSummaryView = (
  attempt: RunSummary["attempts"][number] | RunSnapshot["attempts"][number],
  workers: WorkerAccesses,
): AttemptSummaryView =>
  AttemptSummaryView.make({
    id: attempt.id,
    number: attempt.number,
    worker: attempt.worker,
    workerAccess: workers.get(attempt.worker) ?? null,
    brain: attempt.brain,
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
    outOfMemory: Option.getOrNull(attempt.outOfMemory),
  });

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
  return RunDurationView.make({ endedMillis, runningSince, unmeasured });
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
          TranscriptPageQuery.make({ attemptId: attempt.id, before: Option.none(), limit: 1 }),
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
export const runSummaryView = (
  snapshot: RunSummary,
  pausedLoops: ReadonlySet<LoopName>,
  workers: WorkerAccesses,
  waits: ReadonlyMap<RunId, MachineQuotaWait> = new Map(),
  upgrade: UpgradeDrain | null = null,
): RunSummaryView => {
  const actions = RunState.operatorActions(snapshot.run.state);
  return RunSummaryView.make({
    id: snapshot.run.id,
    itemKey: snapshot.itemKey,
    loop: snapshot.run.loop,
    repository: snapshot.repository,
    agent: snapshot.agent.name,
    agentBrain: snapshot.agent.brain,
    state: snapshot.run.state._tag,
    handoff: snapshot.run.state._tag === "HandedOff" ? snapshot.run.state : null,
    ciWait: snapshot.run.state._tag === "AwaitingCi" ? snapshot.run.state.handoff : null,
    upgradeWait:
      actions.canCancel && upgrade?.runIds.includes(snapshot.run.id) ? upgrade.wait : null,
    providerRetry: Option.getOrNull(pendingProviderRetry(snapshot.run.state, snapshot.attempts)),
    loopPaused: pausedLoops.has(snapshot.run.loop),
    machineWait: actions.canCancel ? (waits.get(snapshot.run.id) ?? null) : null,
    openedAt: DateTime.formatIso(snapshot.run.openedAt),
    closedAt: Option.match(snapshot.closedAt, { onNone: () => null, onSome: DateTime.formatIso }),
    attempts: snapshot.attempts.map((attempt) => attemptSummaryView(attempt, workers)),
    approvalReason: Option.getOrNull(snapshot.approvalReason),
    approval: Option.match(snapshot.approval, {
      onNone: () => null,
      onSome: ({ approvedAt, source }) =>
        ApprovalView.make({
          approvedAt: DateTime.formatIso(approvedAt),
          source: Option.getOrNull(source),
        }),
    }),
    runAgain: Option.getOrNull(snapshot.runAgain),
    pullRequestUrl: snapshot.pullRequestUrl,
    ...actions,
    canResolveFailure:
      actions.canResolveFailure &&
      !Option.contains(snapshot.resolvedFailureAttemptId, snapshot.attempts.at(-1)?.id),
  });
};

/** Returns the full run and attempt prompts for a detail read. */
export const runView = (
  snapshot: RunSnapshot,
  pausedLoops: ReadonlySet<LoopName>,
  workers: WorkerAccesses,
  waits: ReadonlyMap<RunId, MachineQuotaWait> = new Map(),
  upgrade: UpgradeDrain | null = null,
): RunView =>
  RunView.make({
    ...runSummaryView(summarizeRun(snapshot), pausedLoops, workers, waits, upgrade),
    task: snapshot.task,
    resultMessage: Option.match(snapshot.step.result, {
      onNone: () => null,
      onSome: ({ message }) => message,
    }),
    attempts: snapshot.attempts.map((attempt) =>
      AttemptView.make({
        ...attemptSummaryView(attempt, workers),
        task: attempt.task,
      }),
    ),
  });

const transcriptPayload = (
  payload: AttemptChannel.OutboundPayload | AttemptChannel.InboundPayload,
) =>
  Match.valueTags(payload, {
    Started: (value) => value,
    SessionEvent: (value) => value,
    Final: (value) => value,
    Failed: ({ failure }) => FailedTranscriptView.make({ failure: failureView(failure) }),
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
    return TranscriptEventView.make({
      ...fields,
      target: entry.envelope.target,
      operator: entry.envelope.operator,
    });
  }
  return TranscriptEventView.make(fields);
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
    TranscriptPageQuery.make({
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
        ? [TranscriptPageCursor.make({ attemptId, before: first.sequence })]
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
            TranscriptTailQuery.make({
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
        return TranscriptAttemptNotFoundError.make({ runId: snapshot.run.id, attemptId });
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
