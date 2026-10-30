import { AttemptContext } from "@usine/core/attempt";
import { type CycleGeneration, CycleLimit } from "@usine/core/cycle-budget";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ApprovalRequirement, LoopPermissions } from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import { StepName } from "@usine/core/step";
import { type DateTime, Schema } from "effect";
import type { RunSnapshot } from "../run-reader/model.ts";
import { Claimed, CycleBlocked, Submission } from "./submission.ts";

/**
 * An operator request to run a succeeded or canceled Run again with the Loop's current settings
 * (#152). `requestedBy` is `None` if `usine.yaml` sets no operator login.
 */
export class RunAgainRequest extends Schema.Class<RunAgainRequest>("@usine/engine/RunAgainRequest")(
  {
    /** The current loop step name to use for the new run. */
    step: StepName,
    /** The current loop approval requirement, applied again to the new run. */
    approval: ApprovalRequirement,
    /** The cycle limit, or `None` for a schedule Loop. */
    cycleLimit: Schema.Option(CycleLimit),
    /** The current loop repository access granted to the new run's attempts. */
    permissions: LoopPermissions,
    /** The task, agent, and parent model to save as the new run's effective context. */
    context: AttemptContext,
    /** The operator who requested the new run, or `None` when no login was recorded. */
    requestedBy: Schema.Option(OperatorLogin),
  },
) {}

/**
 * The result of a run again: `Claimed` with the new Run, or `CycleBlocked` with the Ask opened
 * because the Item's cycle budget is used up.
 */
export const RunAgainResult = Schema.Union([Claimed, CycleBlocked]);

export type RunAgainResult = typeof RunAgainResult.Type;

/** The position of a run again among the Events opened for one trigger Event. */
export interface RunAgainIdentity {
  /** The dedup key of the trigger Event that the closed Run's Event is or reopened. */
  readonly trigger: DedupKey;
  /** The trigger Event's next reopening number, shared with reopenings (#267). */
  readonly reopening: number;
  /** The Item's cycle generation at the time of the request. */
  readonly generation: CycleGeneration;
  readonly receivedAt: DateTime.Utc;
}

/**
 * Returns the Event for a run again, with the closed Run's Item state and revision, the Loop's
 * current settings, and the operator's task and Agent. Its dedup key,
 * `["operator-run-again", n, <trigger key>]`, never collides with a polled Event.
 */
export const runAgainSubmission = (
  ran: RunSnapshot,
  request: RunAgainRequest,
  identity: RunAgainIdentity,
): Submission => {
  const dedupKey = DedupKey.make(
    JSON.stringify(["operator-run-again", identity.reopening, identity.trigger]),
  );
  return new Submission({
    event: new Event({
      id: EventId.make(dedupKey),
      dedupKey,
      payload: ran.event.payload,
      receivedAt: identity.receivedAt,
    }),
    itemKey: ran.itemKey,
    loop: ran.run.loop,
    step: request.step,
    approval: request.approval,
    permissions: request.permissions,
    cycleLimit: request.cycleLimit,
    cycleGeneration: identity.generation,
    repository: ran.repository,
    revision: ran.revision,
    task: request.context.task,
    agent: request.context.agent,
    parentModel: request.context.parentModel,
  });
};
