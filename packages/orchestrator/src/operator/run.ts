import { SettledItemState } from "@usine/config/board";
import { AgentName } from "@usine/core/agent";
import { BrainSpec } from "@usine/core/agent/brain";
import { TokenCount } from "@usine/core/agent/session";
import { AttemptId, AttemptNumber, AttemptTask, ProviderRetry } from "@usine/core/attempt";
import { OperatorAction, SessionTarget } from "@usine/core/attempt/channel";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { RunAgain } from "@usine/core/run/again";
import { ApprovalSource } from "@usine/core/run/approval";
import * as RunState from "@usine/core/run/state";
import { WorkerName } from "@usine/core/worker";
import { Effect, Schema } from "effect";
import { AttemptView } from "./attempt.ts";
import { MachineView, MachineQuotaWait } from "./machines.ts";
import { TranscriptEventView, TranscriptPageCursor } from "./transcript.ts";
import { RunUsageView } from "./usage.ts";

/** The stored Run lifecycle state as shown in operator views. */
export const RunStateTag = Schema.Literals(RunState.STATE_TAGS);
/** The stored run lifecycle state as shown in operator views. */
export type RunStateTag = typeof RunStateTag.Type;

const NullableString = Schema.NullOr(Schema.String);

/**
 * The operator's replacement task and roster Agent. The server derives the Agent's persona and
 * brain.
 */
export class EditAndRetry extends Schema.Class<EditAndRetry>("@usine/orchestrator/EditAndRetry")({
  /** The replacement task text for subsequent attempts. */
  task: AttemptTask,
  /** The loaded agent to use for subsequent attempts. */
  agent: AgentName,
}) {}

/** An action for a specific live Attempt and session, so stale controls cannot target a new Attempt. */
export class SessionIntervention extends Schema.Class<SessionIntervention>(
  "@usine/orchestrator/SessionIntervention",
)({
  /** The attempt associated with this entry. */
  attemptId: AttemptId,
  /** The parent or child session to receive the intervention. */
  target: SessionTarget.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ _tag: "Parent" }))),
  /** The message or session control requested by the operator. */
  action: OperatorAction,
}) {}

/** The requested Agent isn't in the loaded roster. */
export class RosterAgentNotFoundError extends Schema.TaggedError<RosterAgentNotFoundError>(
  "@usine/orchestrator/RosterAgentNotFoundError",
)("RosterAgentNotFoundError", {
  /** The referenced agent name. */
  agent: AgentName,
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/** The Run's Loop isn't in the loaded instance, so a new Run of it can't be opened. */
export class LoopNotFoundError extends Schema.TaggedError<LoopNotFoundError>(
  "@usine/orchestrator/LoopNotFoundError",
)("LoopNotFoundError", {
  /** The project-qualified loop name. */
  loop: LoopName,
  /** The diagnostic text to show to the operator. */
  message: Schema.String,
}) {}

/** A Run's approval: when it was given and, if recorded, who gave it and through which channel. */
export class ApprovalView extends Schema.Class<ApprovalView>("@usine/orchestrator/ApprovalView")({
  /** The recorded approval time as an ISO 8601 timestamp. */
  approvedAt: Schema.String,
  /** Null for approvals given before the approver was recorded. */
  source: Schema.NullOr(ApprovalSource),
}) {}

/** A Run with its Attempts, result links, and available operator actions. */
export class RunView extends Schema.Class<RunView>("@usine/orchestrator/RunView")({
  /** The persistent run identity. */
  id: RunId,
  /** The stored item identity, including its stream and repository. */
  itemKey: ItemKey,
  /** The project-qualified loop name. */
  loop: LoopName,
  /** The managed repo, in `owner/name` form. */
  repository: RepositoryName,
  /** The referenced agent name. */
  agent: AgentName,
  /** The saved agent definition's brain, including any edit-and-retry amendment. */
  agentBrain: BrainSpec,
  /** The current lifecycle state. */
  state: RunStateTag,
  /** The pending provider-capacity retry, or null when none is scheduled. */
  providerRetry: Schema.NullOr(ProviderRetry).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The worker quota refusal while this run waits for its machine, or null. */
  machineWait: Schema.NullOr(MachineQuotaWait).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Whether the loop is currently paused. */
  loopPaused: Schema.Boolean,
  /** The run opening time as an ISO 8601 timestamp. */
  openedAt: Schema.String,
  /**
   * When the Run last succeeded, failed, or was canceled, even before any Attempt. Null while open;
   * a retry reopens a failed Run and clears it.
   */
  closedAt: Schema.NullOr(Schema.String),
  /** The effective task text, including any edit-and-retry amendment. */
  task: Schema.String,
  /** The recorded attempts in attempt-number order. */
  attempts: Schema.Array(AttemptView),
  /**
   * The approval the Run consumed, or null until one arrives. Always null for a Loop with
   * `approval: none`.
   */
  approval: Schema.NullOr(ApprovalView),
  /** The saved approval decision, or null for older events. */
  approvalReason: Schema.NullOr(Schema.NonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * The closed Run that the operator ran again to open this one, and who asked, or null for a
   * trigger-opened Run. Its time is `openedAt`.
   */
  runAgain: Schema.NullOr(RunAgain),
  /** The successful result message, or null without one. */
  resultMessage: NullableString,
  /** The pull request URL reported by a successful attempt, or null without one. */
  pullRequestUrl: NullableString,
  /** Whether the run is waiting for approval. */
  canApprove: Schema.Boolean,
  /** Whether the run can accept an operator retry. */
  canRetry: Schema.Boolean,
  /**
   * Whether the latest failed Attempt still requests attention, independent of retry availability.
   */
  canResolveFailure: Schema.Boolean,
  /** Whether the run is still open and can be canceled. */
  canCancel: Schema.Boolean,
  /**
   * Whether the Run succeeded or was canceled, so the operator can open a new Run for its Item
   * state.
   */
  canRunAgain: Schema.Boolean,
}) {}

const Milliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The time a Run's Attempts worked, summed per Attempt. */
export class RunDurationView extends Schema.Class<RunDurationView>(
  "@usine/orchestrator/RunDurationView",
)({
  /** The ended Attempts' time, each from start to recorded end. */
  endedMillis: Milliseconds,
  /** The start of the running Attempt, or null if none runs. */
  runningSince: Schema.NullOr(Schema.String),
  /**
   * The number of ended Attempts closed before end times were recorded, excluded from the total.
   */
  unmeasured: Count,
}) {}

/**
 * An Attempt on the Run's Loop and Item whose parent task isn't confirmed stopped. The open Run
 * starts no Attempt until a reconcile confirms the stop (#523).
 */
export class UnconfirmedStopView extends Schema.Class<UnconfirmedStopView>(
  "@usine/orchestrator/UnconfirmedStopView",
)({
  /** The Run of the Attempt: this Run, or an earlier Run of the Loop on the Item. */
  runId: RunId,
  /** The one-based attempt number within the run. */
  attemptNumber: AttemptNumber,
  /** The configured worker name. */
  worker: WorkerName,
}) {}

/** A Run with its triggering Event payload, a page of its transcript, and its usage. */
export class RunDetailView extends Schema.Class<RunDetailView>("@usine/orchestrator/RunDetailView")(
  {
    /** The run summary and its attempts. */
    run: RunView,
    /** Whether the loaded agent differs from the saved definition; false if no longer loaded. */
    agentDefinitionChanged: Schema.Boolean,
    /** The deduplication key of the event that opened the run. */
    eventDedupKey: Schema.String,
    /** The saved event payload used for trigger evaluation and task rendering. */
    eventPayload: Schema.Json,
    /** Transcript events selected by the cold, tail, or earlier-page request. */
    transcript: Schema.Array(TranscriptEventView),
    /**
     * The current session controls, included even when their last activity is before the transcript
     * page.
     */
    sessionState: Schema.Array(TranscriptEventView),
    /** Per-attempt cursors for earlier transcript rows omitted from this response. */
    earlierTranscript: Schema.Array(TranscriptPageCursor),
    /** The Worker of the newest Attempt, or null before the first Attempt. */
    worker: Schema.NullOr(WorkerName).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
    /**
     * The state of the Run's Item from the newest poll if the Item is closed, merged, or gone, else
     * null. Needs attention leaves out a failed Run on such an Item.
     */
    settledItemState: Schema.NullOr(SettledItemState).pipe(
      Schema.withConstructorDefault(Effect.succeed(null)),
    ),
    /** Summed attempt wall time and start times of attempts still running. */
    duration: RunDurationView.pipe(
      Schema.withConstructorDefault(
        Effect.succeed(new RunDurationView({ endedMillis: 0, runningSince: null, unmeasured: 0 })),
      ),
    ),
    /** Reported session tokens and costs across the run attempts. */
    usage: RunUsageView.pipe(
      Schema.withConstructorDefault(
        Effect.succeed(new RunUsageView({ tokens: TokenCount.make(0), pools: [], sessions: [] })),
      ),
    ),
    /** The unconfirmed stop that keeps the open Run from starting an Attempt, or null. */
    unconfirmedStop: Schema.NullOr(UnconfirmedStopView).pipe(
      Schema.withConstructorDefault(Effect.succeed(null)),
    ),
    /**
     * The machine a provisioned Worker creates or holds for the Run's next or running Attempt, or
     * null.
     */
    machine: Schema.NullOr(MachineView).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  },
) {}
