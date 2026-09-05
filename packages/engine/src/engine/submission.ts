import { Agent } from "@usine/core/agent";
import { ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName, ApprovalRequirement } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { Schema } from "effect";

/** A matched Event with the Loop, Item, and execution choices that determine the work owed. */
export class Submission extends Schema.Class<Submission>("@usine/engine/Submission")({
  event: Event,
  itemKey: ItemKey,
  loop: LoopName,
  step: StepName,
  approval: ApprovalRequirement,
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
}) {}

/** The Event now owns a Run; submitting it again returns the same run id. */
export class Claimed extends Schema.TaggedClass<Claimed>("@usine/engine/Claimed")("Claimed", {
  eventId: EventId,
  runId: RunId,
}) {}

/** A running Attempt on the same Item must finish before this Event is reconsidered. */
export class Queued extends Schema.TaggedClass<Queued>("@usine/engine/Queued")("Queued", {
  eventId: EventId,
}) {}

export const IGNORED_REASONS = ["superseded", "revoked"] as const;

export const IgnoreReason = Schema.Literals(IGNORED_REASONS);

export type IgnoreReason = typeof IgnoreReason.Type;

/** The Event stays in the ledger but can no longer open a Run. */
export class Ignored extends Schema.TaggedClass<Ignored>("@usine/engine/Ignored")("Ignored", {
  eventId: EventId,
  reason: IgnoreReason,
}) {}

/** Whether a recorded Event owns a Run, waits behind running work, or can no longer open a Run. */
export const SubmissionResult = Schema.Union([Claimed, Queued, Ignored]);

export type SubmissionResult = typeof SubmissionResult.Type;
