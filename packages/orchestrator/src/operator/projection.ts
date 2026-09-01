import { Loop, RunState, StepResult } from "@usine/core";
import {
  RunReader,
  TranscriptPageQuery,
  TranscriptTailQuery,
  type RunSnapshot,
  type RunStoreError,
  type RunSummary,
  type TranscriptEntry,
} from "@usine/engine";
import { DateTime, Effect, Match, Option } from "effect";
import {
  AttemptView,
  type TranscriptRequest,
  TranscriptAttemptNotFoundError,
  RunView,
  TranscriptPageCursor,
  TranscriptEventView,
} from "./model.ts";

/** Newest rows one cold drawer open ships per Attempt. */
export const COLD_TRANSCRIPT_LIMIT = 500;

const attemptView = (attempt: RunSnapshot["attempts"][number]): AttemptView => {
  return new AttemptView({
    id: attempt.id,
    number: attempt.number,
    worker: attempt.worker,
    brain: attempt.brain,
    startedAt: DateTime.formatIso(attempt.startedAt),
    outcome: Option.getOrNull(attempt.outcome),
  });
};

export const runView = (snapshot: RunSummary, pausedLoops: ReadonlySet<Loop.LoopName>): RunView => {
  const result = Option.getOrNull(snapshot.step.result);
  const pullRequest = result?.facts.find(
    (fact): fact is StepResult.PullRequest => fact._tag === "PullRequest",
  );
  return new RunView({
    id: snapshot.run.id,
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
    canApprove: snapshot.run.state._tag === "Waiting",
    canRetry: snapshot.run.state._tag === "Failed",
    canCancel: RunState.isOpen(snapshot.run.state),
  });
};

const transcriptEvent = (entry: TranscriptEntry): TranscriptEventView =>
  new TranscriptEventView({
    sequence: entry.sequence,
    attemptId: entry.attemptId,
    receivedAt: DateTime.formatIso(entry.receivedAt),
    direction: entry.direction,
    payload: entry.envelope.payload,
  });

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
)(
  (
    runs: RunReader["Service"],
    snapshot: RunSnapshot,
    request: TranscriptRequest,
  ): Effect.Effect<TranscriptRead, RunStoreError | TranscriptAttemptNotFoundError> =>
    Match.valueTags(request, {
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
          (attempt) => runs.transcript(new TranscriptTailQuery({ attemptId: attempt.id, after })),
          { concurrency: 4 },
        ).pipe(Effect.map((entries) => ({ events: sortedEvents(entries.flat()), earlier: [] }))),
      EarlierTranscriptRequest: ({ attemptId, before }) => {
        if (!snapshot.attempts.some((attempt) => attempt.id === attemptId)) {
          return new TranscriptAttemptNotFoundError({ runId: snapshot.run.id, attemptId });
        }
        return readPage(runs, attemptId, Option.some(before));
      },
    }),
);
