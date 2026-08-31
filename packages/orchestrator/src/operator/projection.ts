import { RunState, StepResult } from "@usine/core";
import {
  RunEngine,
  TranscriptQuery,
  type RunEngineError,
  type RunSnapshot,
  type TranscriptEntry,
} from "@usine/engine";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  AttemptView,
  RunView,
  TranscriptEventView,
  type TranscriptCursor,
  type TranscriptScope,
} from "./model.ts";

const jsonDetail = (value: Schema.Json): string => JSON.stringify(value, null, 2) ?? "null";

const failureMessage = (failure: { readonly _tag: string; readonly message?: string }): string =>
  failure.message ??
  (failure._tag === "RunawayFailure" ? "Attempt exceeded its safety ceiling" : failure._tag);

const attemptView = (attempt: RunSnapshot["attempts"][number]): AttemptView => {
  const outcome = Option.getOrNull(attempt.outcome);
  const failure = outcome?._tag === "Failed" ? outcome.failure : null;
  return new AttemptView({
    id: attempt.id,
    number: attempt.number,
    worker: attempt.worker,
    brain: `${attempt.brain.harness} · ${attempt.brain.model} · ${attempt.brain.effort}`,
    startedAt: DateTime.formatIso(attempt.startedAt),
    outcome: outcome?._tag ?? null,
    errorTag: failure?._tag ?? null,
    errorMessage: failure === null ? null : failureMessage(failure),
  });
};

export const runView = (snapshot: RunSnapshot): RunView => {
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

const transcriptEvent = (entry: TranscriptEntry): TranscriptEventView => {
  const payload = entry.envelope.payload;
  let scope: TranscriptScope = "channel";
  let sessionId: string | null = null;
  let parentId: string | null = null;
  let agent: string | null = null;
  let label: string = payload._tag;
  let detail = "";
  let isError = false;

  if (payload._tag === "SessionEvent") {
    const event = payload.event;
    const session = event.session;
    scope = session._tag === "ChildSession" ? "child" : "parent";
    sessionId = session.id;
    parentId = session._tag === "ChildSession" ? session.parentId : null;
    agent = session.agent;
    switch (event._tag) {
      case "SessionStarted":
        label = `${session.agent} started`;
        detail = `${session.brain.harness} · ${session.brain.model} · ${session.brain.effort}`;
        break;
      case "TextOutput":
        label = session.agent;
        detail = event.text;
        break;
      case "ToolStarted":
        label = `${event.tool} started`;
        detail = jsonDetail(event.input);
        break;
      case "ToolFinished":
        label = `${event.tool} ${event.isError ? "failed" : "finished"}`;
        detail = jsonDetail(event.output);
        isError = event.isError;
        break;
      case "SessionFinished":
        label = `${session.agent} finished`;
        break;
    }
  } else if (payload._tag === "Final") {
    label = "Attempt finished";
    detail = payload.result.message;
  } else if (payload._tag === "Failed") {
    label = payload.failure._tag;
    detail = failureMessage(payload.failure);
    isError = true;
  } else if (payload._tag === "Steer") {
    label = "Operator message";
    detail = payload.message;
  } else if (payload._tag === "Interrupted") {
    detail = "The run host acknowledged the interrupt.";
  }

  return new TranscriptEventView({
    sequence: entry.sequence,
    attemptId: entry.attemptId,
    receivedAt: DateTime.formatIso(entry.receivedAt),
    scope,
    kind: payload._tag === "SessionEvent" ? payload.event._tag : payload._tag,
    sessionId,
    parentId,
    agent,
    label,
    detail,
    isError,
  });
};

export const readTranscript: (
  runs: RunEngine["Service"],
  snapshot: RunSnapshot,
  after?: Option.Option<TranscriptCursor>,
) => Effect.Effect<ReadonlyArray<TranscriptEventView>, RunEngineError> = Effect.fn(
  "Operator.readTranscript",
)(
  (
    runs: RunEngine["Service"],
    snapshot: RunSnapshot,
    after: Option.Option<TranscriptCursor> = Option.none(),
  ): Effect.Effect<ReadonlyArray<TranscriptEventView>, RunEngineError> =>
    Effect.gen(function* () {
      const entries = yield* Effect.forEach(
        snapshot.attempts,
        (attempt) => runs.transcript(new TranscriptQuery({ attemptId: attempt.id, after })),
        { concurrency: 4 },
      );
      return entries
        .flat()
        .sort((left, right) => left.sequence - right.sequence)
        .map(transcriptEvent);
    }),
);
