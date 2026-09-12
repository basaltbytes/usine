import * as AttemptChannel from "@usine/core/attempt/channel";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { AttemptOutcome } from "@usine/core/attempt/outcome";
import { LoopName } from "@usine/core/loop";
import * as RunState from "@usine/core/run/state";
import { PullRequest } from "@usine/core/step/result";
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
  CanceledAttemptView,
  ChildSessionBudgetFailureView,
  DefectFailureView,
  FailedAttemptView,
  type FailureView,
  InfraFailureView,
  RunawayFailureView,
  SucceededAttemptView,
} from "./attempt.ts";
import {
  FailedTranscriptView,
  type TranscriptRequest,
  TranscriptAttemptNotFoundError,
  TranscriptPageCursor,
  TranscriptEventView,
} from "./transcript.ts";
import { RunView } from "./run.ts";

/** How many newest rows one cold drawer open loads per Attempt. */
const COLD_TRANSCRIPT_LIMIT = 500;
/** The row cap for one live catch-up response across all Attempts. */
const TAIL_TRANSCRIPT_LIMIT = 500;

export const failureView = (failure: AttemptFailure): FailureView =>
  Match.valueTags(failure, {
    InfraFailure: ({ message }) => new InfraFailureView({ message }),
    DefectFailure: ({ message }) => new DefectFailureView({ message }),
    AgentFailure: ({ message }) => new AgentFailureView({ message }),
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

const attemptView = (attempt: RunSnapshot["attempts"][number]): AttemptView => {
  return new AttemptView({
    id: attempt.id,
    number: attempt.number,
    worker: attempt.worker,
    brain: attempt.brain,
    task: attempt.task,
    agent: attempt.agent,
    operatorIntervened: attempt.operatorIntervened,
    startedAt: DateTime.formatIso(attempt.startedAt),
    outcome: Option.match(attempt.outcome, {
      onNone: () => null,
      onSome: attemptOutcomeView,
    }),
  });
};

export const runView = (snapshot: RunSummary, pausedLoops: ReadonlySet<LoopName>): RunView => {
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
    task: snapshot.task,
    attempts: snapshot.attempts.map(attemptView),
    resultMessage: result?.message ?? null,
    pullRequestUrl: pullRequest?.url.toString() ?? null,
    ...RunState.operatorActions(snapshot.run.state),
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
  });

/** Projects one transcript row, preserving attribution and excluding private failure causes. */
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
