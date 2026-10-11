import { Agent } from "@usine/core/agent";
import {
  CycleBudgetAsk,
  CycleGeneration,
  CycleLimit,
  DEFAULT_CYCLE_LIMIT,
} from "@usine/core/cycle-budget";
import { ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName, ApprovalRequirement } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { Crypto, Effect, Encoding, Option, Schema } from "effect";

/** A matched Event with the Loop, Item, and execution choices that determine the work owed. */
export class Submission extends Schema.Class<Submission>("@usine/engine/Submission")({
  event: Event,
  itemKey: ItemKey,
  loop: LoopName,
  step: StepName,
  approval: ApprovalRequirement,
  /** Item Runs default to three rounds; schedule adapters explicitly supply None. */
  cycleLimit: Schema.Option(CycleLimit).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(Option.some(DEFAULT_CYCLE_LIMIT))),
    Schema.withConstructorDefault(Effect.succeed(Option.some(DEFAULT_CYCLE_LIMIT))),
  ),
  /** Capture before fetching trigger input. A reset supersedes older observations. */
  cycleGeneration: CycleGeneration.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(CycleGeneration.make(0))),
    Schema.withConstructorDefault(Effect.succeed(CycleGeneration.make(0))),
  ),
  repository: RepositoryName,
  revision: RepositoryRevision,
  task: AttemptTask,
  agent: Agent,
  parentModel: Schema.Option(ModelId),
}) {}

// Runs opened before the engine drove them itself took this Effect workflow
// execution id; hashing the same input keeps every Run id stable.
const RUN_ID_NAMESPACE = "@usine/engine/DurableRun";

/**
 * The id of the Run a Submission's Event opens: the first 16 bytes of the
 * SHA-256 of the Event's dedup key, in hex. The same Event always names the same Run.
 */
export const runIdFor = Effect.fn("Submission.runIdFor")(function* (submission: Submission) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`${RUN_ID_NAMESPACE}-${submission.event.dedupKey}`))
    .pipe(Effect.orDie);
  return RunId.make(Encoding.encodeHex(digest.subarray(0, 16)));
});

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

/** No Run opened because this Item requires an explicit cycle-budget reset. */
export class CycleBlocked extends Schema.TaggedClass<CycleBlocked>("@usine/engine/CycleBlocked")(
  "CycleBlocked",
  { eventId: EventId, ask: CycleBudgetAsk },
) {}

/** Whether a recorded Event owns a Run, waits behind running work, or can no longer open a Run. */
export const SubmissionResult = Schema.Union([Claimed, Queued, Ignored, CycleBlocked]);

export type SubmissionResult = typeof SubmissionResult.Type;
