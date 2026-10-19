import { AgentName } from "@usine/core/agent";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import { OperatorAction, SessionTarget } from "@usine/core/attempt/channel";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import { ApprovalSource } from "@usine/core/run/approval";
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

/** The Run's Loop is not in the loaded instance, so nothing says how a new Run of it opens. */
export class LoopNotFoundError extends Schema.TaggedError<LoopNotFoundError>(
  "@usine/orchestrator/LoopNotFoundError",
)("LoopNotFoundError", { loop: LoopName, message: Schema.String }) {}

/** A Run's approval: when it was given and, once usine recorded it, who gave it through which channel. */
export class ApprovalView extends Schema.Class<ApprovalView>("@usine/orchestrator/ApprovalView")({
  approvedAt: Schema.String,
  /** Null for approvals given before usine recorded who approved. */
  source: Schema.NullOr(ApprovalSource),
}) {}

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
  /** The approval the Run consumed; null until one arrives, and always null for a Loop with `approval: none`. */
  approval: Schema.NullOr(ApprovalView),
  /** The closed Run the operator ran again to open this one, and who asked; null for a Run its trigger opened. Its time is `openedAt`. */
  runAgain: Schema.NullOr(RunAgain),
  resultMessage: NullableString,
  pullRequestUrl: NullableString,
  canApprove: Schema.Boolean,
  canRetry: Schema.Boolean,
  /** The latest failed Attempt still requests attention; retry availability is independent. */
  canResolveFailure: Schema.Boolean,
  canCancel: Schema.Boolean,
  /** The Run succeeded or was canceled, so the operator can open a new Run for its Item state. */
  canRunAgain: Schema.Boolean,
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
