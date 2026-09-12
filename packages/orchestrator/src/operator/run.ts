import { AgentName } from "@usine/core/agent";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import { OperatorAction, SessionTarget } from "@usine/core/attempt/channel";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import * as RunState from "@usine/core/run/state";
import { Effect, Schema } from "effect";
import { AttemptView } from "./attempt.ts";
import { TranscriptEventView, TranscriptPageCursor } from "./transcript.ts";

/** The persisted Run lifecycle state as exposed in operator views. */
export const RunStateTag = Schema.Literals(RunState.STATE_TAGS);
export type RunStateTag = typeof RunStateTag.Type;

const NullableString = Schema.NullOr(Schema.String);

/** The operator's replacement task and selected roster member; the server derives the Agent's persona and brain. */
export class EditAndRetry extends Schema.Class<EditAndRetry>("@usine/orchestrator/EditAndRetry")({
  task: AttemptTask,
  agent: AgentName,
}) {}

/** An action for a specific live Attempt and session, so stale controls cannot target a new Attempt. */
export class SessionIntervention extends Schema.Class<SessionIntervention>(
  "@usine/orchestrator/SessionIntervention",
)({
  attemptId: AttemptId,
  target: SessionTarget.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ _tag: "Parent" }))),
  action: OperatorAction,
}) {}

/** The requested Agent is absent from the loaded instance roster. */
export class RosterAgentNotFoundError extends Schema.TaggedError<RosterAgentNotFoundError>(
  "@usine/orchestrator/RosterAgentNotFoundError",
)("RosterAgentNotFoundError", { agent: AgentName, message: Schema.String }) {}

/** A Run summary with its Attempts, result links, and currently available operator actions. */
export class RunView extends Schema.Class<RunView>("@usine/orchestrator/RunView")({
  id: RunId,
  itemKey: ItemKey,
  loop: LoopName,
  repository: RepositoryName,
  agent: AgentName,
  state: RunStateTag,
  loopPaused: Schema.Boolean,
  openedAt: Schema.String,
  task: Schema.String,
  attempts: Schema.Array(AttemptView),
  resultMessage: NullableString,
  pullRequestUrl: NullableString,
  canApprove: Schema.Boolean,
  canRetry: Schema.Boolean,
  canCancel: Schema.Boolean,
}) {}

/** A Run summary with its triggering Event payload and a bounded portion of its transcript. */
export class RunDetailView extends Schema.Class<RunDetailView>("@usine/orchestrator/RunDetailView")(
  {
    run: RunView,
    eventDedupKey: Schema.String,
    eventPayload: Schema.Json,
    transcript: Schema.Array(TranscriptEventView),
    /** Current session controls remain available when their last activity predates the transcript page. */
    sessionState: Schema.Array(TranscriptEventView),
    earlierTranscript: Schema.Array(TranscriptPageCursor),
  },
) {}
