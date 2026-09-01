import { Agent, AttemptChannel, AttemptFailure, Loop, RunState, StepResult } from "@usine/core";
import {
  RunReader,
  TranscriptQuery,
  type RunSnapshot,
  type RunStoreError,
  type RunSummary,
  type TranscriptEntry,
} from "@usine/engine";
import { DateTime, Effect, Match, Option, Schema } from "effect";
import {
  AttemptView,
  RunView,
  TranscriptEventView,
  type TranscriptCursor,
  type TranscriptScope,
} from "./model.ts";

/**
 * Newest rows one cold drawer open ships per Attempt; a "load earlier" page
 * over the same cursor is deliberately deferred until the dogfood needs it.
 */
export const COLD_TRANSCRIPT_LIMIT = 500;

const jsonDetail = (value: Schema.Json): string => JSON.stringify(value, null, 2);

const brainLine = (brain: {
  readonly harness: string;
  readonly model: string;
  readonly effort: string;
}): string => `${brain.harness} · ${brain.model} · ${brain.effort}`;

const failureMessage = (failure: AttemptFailure.AttemptFailure): string =>
  Match.valueTags(failure, {
    InfraFailure: ({ message }) => message,
    AgentFailure: ({ message }) => message,
    RunawayFailure: ({ ceiling }) => `Runaway guard tripped its ${ceiling} ceiling`,
  });

const attemptView = (attempt: RunSnapshot["attempts"][number]): AttemptView => {
  const outcome = Option.getOrNull(attempt.outcome);
  const failure = outcome?._tag === "Failed" ? outcome.failure : null;
  return new AttemptView({
    id: attempt.id,
    number: attempt.number,
    worker: attempt.worker,
    brain: brainLine(attempt.brain),
    startedAt: DateTime.formatIso(attempt.startedAt),
    outcome: outcome?._tag ?? null,
    errorTag: failure?._tag ?? null,
    errorMessage: failure === null ? null : failureMessage(failure),
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

interface ProjectedTranscriptEvent {
  readonly scope: TranscriptScope;
  readonly kind: string;
  readonly sessionId: string | null;
  readonly parentId: string | null;
  readonly agent: string | null;
  readonly label: string;
  readonly detail: string;
  readonly isError: boolean;
}

const channelEvent = (kind: string, label: string, detail: string, isError = false) => ({
  scope: "channel" as const,
  kind,
  sessionId: null,
  parentId: null,
  agent: null,
  label,
  detail,
  isError,
});

const rateLimitWindow = (
  name: string,
  window: Option.Option<Agent.RateLimitWindow>,
): ReadonlyArray<string> =>
  Option.match(window, {
    onNone: () => [],
    onSome: ({ usedPercent }) => [`${name} ${usedPercent}% used`],
  });

const projectSessionEvent = (event: Agent.SessionEvent): ProjectedTranscriptEvent => {
  const session = event.session;
  const scope: TranscriptScope = session._tag === "ChildSession" ? "child" : "parent";
  const base = {
    scope,
    kind: event._tag,
    sessionId: session.id,
    parentId: session._tag === "ChildSession" ? session.parentId : null,
    agent: session.agent,
    detail: "",
    isError: false,
  };
  return Match.valueTags(event, {
    SessionStarted: () => ({
      ...base,
      label: `${session.agent} started`,
      detail: brainLine(session.brain),
    }),
    TextOutput: ({ text }) => ({ ...base, label: session.agent, detail: text }),
    ToolStarted: ({ tool, input }) => ({
      ...base,
      label: `${tool} started`,
      detail: jsonDetail(input),
    }),
    ToolFinished: ({ tool, output, isError }) => ({
      ...base,
      label: `${tool} ${isError ? "failed" : "finished"}`,
      detail: jsonDetail(output),
      isError,
    }),
    PoolRateLimitsUpdated: ({ pool, rateLimits }) => ({
      ...base,
      label: `${pool} rate limits updated`,
      detail: [
        ...rateLimitWindow("primary", rateLimits.primary),
        ...rateLimitWindow("secondary", rateLimits.secondary),
      ].join(" · "),
    }),
    SessionFinished: () => ({ ...base, label: `${session.agent} finished` }),
  });
};

const projectPayload = (
  payload: AttemptChannel.OutboundPayload | AttemptChannel.InboundPayload,
): ProjectedTranscriptEvent =>
  Match.valueTags(payload, {
    Started: ({ parentModel }) => channelEvent("Started", "Attempt started", parentModel),
    SessionEvent: ({ event }) => projectSessionEvent(event),
    Final: ({ result }) => channelEvent("Final", "Attempt finished", result.message),
    Failed: ({ failure }) => channelEvent("Failed", failure._tag, failureMessage(failure), true),
    Interrupted: () =>
      channelEvent("Interrupted", "Interrupted", "The run host acknowledged the interrupt."),
    Steer: ({ message }) => channelEvent("Steer", "Operator message", message),
    Interrupt: () =>
      channelEvent("Interrupt", "Interrupt", "The operator asked the run host to stop."),
  });

const transcriptEvent = (entry: TranscriptEntry): TranscriptEventView =>
  new TranscriptEventView({
    sequence: entry.sequence,
    attemptId: entry.attemptId,
    receivedAt: DateTime.formatIso(entry.receivedAt),
    ...projectPayload(entry.envelope.payload),
  });

export const readTranscript: (
  runs: RunReader["Service"],
  snapshot: RunSnapshot,
  after?: Option.Option<TranscriptCursor>,
) => Effect.Effect<ReadonlyArray<TranscriptEventView>, RunStoreError> = Effect.fn(
  "Operator.readTranscript",
)(
  (
    runs: RunReader["Service"],
    snapshot: RunSnapshot,
    after: Option.Option<TranscriptCursor> = Option.none(),
  ): Effect.Effect<ReadonlyArray<TranscriptEventView>, RunStoreError> =>
    Effect.gen(function* () {
      // A cold read (no cursor) is capped per Attempt so one long transcript
      // cannot balloon the response; a tail read replays nothing anyway.
      const limit = Option.isNone(after) ? Option.some(COLD_TRANSCRIPT_LIMIT) : Option.none();
      const entries = yield* Effect.forEach(
        snapshot.attempts,
        (attempt) => runs.transcript(new TranscriptQuery({ attemptId: attempt.id, after, limit })),
        { concurrency: 4 },
      );
      return entries
        .flat()
        .sort((left, right) => left.sequence - right.sequence)
        .map(transcriptEvent);
    }),
);
