import { SettledItemState } from "@usine/config/board";
import { AgentName } from "@usine/core/agent";
import { BrainSpec } from "@usine/core/agent/brain";
import { TokenCount } from "@usine/core/agent/session";
import { AttemptId, AttemptNumber, AttemptTask } from "@usine/core/attempt";
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
import { MachineView, WorkerQuotaView } from "./machines.ts";
import { TranscriptEventView, TranscriptPageCursor } from "./transcript.ts";
import { RunUsageView } from "./usage.ts";

/** The stored Run lifecycle state as shown in operator views. */
export const RunStateTag = Schema.Literals(RunState.STATE_TAGS);
export type RunStateTag = typeof RunStateTag.Type;

const NullableString = Schema.NullOr(Schema.String);

/**
 * The operator's replacement task and roster Agent. The server derives the Agent's persona and
 * brain.
 */
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

/** The requested Agent isn't in the loaded roster. */
export class RosterAgentNotFoundError extends Schema.TaggedError<RosterAgentNotFoundError>(
  "@usine/orchestrator/RosterAgentNotFoundError",
)("RosterAgentNotFoundError", { agent: AgentName, message: Schema.String }) {}

/** The Run's Loop isn't in the loaded instance, so a new Run of it can't be opened. */
export class LoopNotFoundError extends Schema.TaggedError<LoopNotFoundError>(
  "@usine/orchestrator/LoopNotFoundError",
)("LoopNotFoundError", { loop: LoopName, message: Schema.String }) {}

/** A Run's approval: when it was given and, if recorded, who gave it and through which channel. */
export class ApprovalView extends Schema.Class<ApprovalView>("@usine/orchestrator/ApprovalView")({
  approvedAt: Schema.String,
  /** Null for approvals given before the approver was recorded. */
  source: Schema.NullOr(ApprovalSource),
}) {}

/** A Run with its Attempts, result links, and available operator actions. */
export class RunView extends Schema.Class<RunView>("@usine/orchestrator/RunView")({
  id: RunId,
  itemKey: ItemKey,
  loop: LoopName,
  repository: RepositoryName,
  agent: AgentName,
  /** The saved agent definition's brain, including any edit-and-retry amendment. */
  agentBrain: BrainSpec,
  state: RunStateTag,
  loopPaused: Schema.Boolean,
  /** Provider quota refusals affecting the workers available for the next attempt. */
  provisioning: Schema.Array(WorkerQuotaView).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  openedAt: Schema.String,
  /**
   * When the Run last succeeded, failed, or was canceled, even before any Attempt. Null while open;
   * a retry reopens a failed Run and clears it.
   */
  closedAt: Schema.NullOr(Schema.String),
  task: Schema.String,
  attempts: Schema.Array(AttemptView),
  /**
   * The approval the Run consumed, or null until one arrives. Always null for a Loop with
   * `approval: none`.
   */
  approval: Schema.NullOr(ApprovalView),
  /**
   * The closed Run that the operator ran again to open this one, and who asked, or null for a
   * trigger-opened Run. Its time is `openedAt`.
   */
  runAgain: Schema.NullOr(RunAgain),
  resultMessage: NullableString,
  pullRequestUrl: NullableString,
  canApprove: Schema.Boolean,
  canRetry: Schema.Boolean,
  /**
   * Whether the latest failed Attempt still requests attention, independent of retry availability.
   */
  canResolveFailure: Schema.Boolean,
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
  attemptNumber: AttemptNumber,
  worker: WorkerName,
}) {}

/** A Run with its triggering Event payload, a page of its transcript, and its usage. */
export class RunDetailView extends Schema.Class<RunDetailView>("@usine/orchestrator/RunDetailView")(
  {
    run: RunView,
    /** Whether the loaded agent differs from the saved definition; false if no longer loaded. */
    agentDefinitionChanged: Schema.Boolean,
    eventDedupKey: Schema.String,
    eventPayload: Schema.Json,
    transcript: Schema.Array(TranscriptEventView),
    /**
     * The current session controls, included even when their last activity is before the transcript
     * page.
     */
    sessionState: Schema.Array(TranscriptEventView),
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
    duration: RunDurationView.pipe(
      Schema.withConstructorDefault(
        Effect.succeed(new RunDurationView({ endedMillis: 0, runningSince: null, unmeasured: 0 })),
      ),
    ),
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
