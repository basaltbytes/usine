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
 * The operator's request to run a succeeded or canceled Run again (#152): the
 * Step, approval requirement, cycle limit, and permission level the Loop file
 * names now, as a polled Event would carry them, the task and Agent the new
 * Run starts with, and the operator login that asked, none while `usine.yaml`
 * names no operator.
 */
export class RunAgainRequest extends Schema.Class<RunAgainRequest>("@usine/engine/RunAgainRequest")(
  {
    step: StepName,
    approval: ApprovalRequirement,
    /** None for a schedule Loop, whose Runs no cycle budget counts. */
    cycleLimit: Schema.Option(CycleLimit),
    permissions: LoopPermissions,
    context: AttemptContext,
    requestedBy: Schema.Option(OperatorLogin),
  },
) {}

/**
 * What running a Run again did: `Claimed` names the new Run, and
 * `CycleBlocked` the Ask the Item's used-up cycle budget opened instead.
 */
export const RunAgainResult = Schema.Union([Claimed, CycleBlocked]);

export type RunAgainResult = typeof RunAgainResult.Type;

/** Where a run again sits among the Events opened for one trigger Event. */
export interface RunAgainIdentity {
  /** The dedup key of the trigger Event the closed Run's Event is, or reopened. */
  readonly trigger: DedupKey;
  /** The next of the trigger Event's reopening numbers, shared with reopenings (#267). */
  readonly reopening: number;
  /** The Item's cycle generation when the operator asked. */
  readonly generation: CycleGeneration;
  readonly receivedAt: DateTime.Utc;
}

/**
 * The Event a run again records: the closed Run's Item state and revision with
 * the Loop's current settings and the operator's task and Agent, under the dedup
 * key `["operator-run-again", n, <trigger key>]`. The key never collides with a
 * polled Event, and the new Run's id, hashed from it, is its own.
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
