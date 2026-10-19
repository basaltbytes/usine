import { Agent } from "@usine/core/agent";
import {
  CycleBudgetAsk,
  CycleGeneration,
  CycleLimit,
  DEFAULT_CYCLE_LIMIT,
} from "@usine/core/cycle-budget";
import { ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName, ApprovalRequirement, LoopPermissions } from "@usine/core/loop";
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
  /** What the Run's Attempts may do to their repository, from the Loop when the Event matched. */
  permissions: LoopPermissions.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("write" as const)),
    Schema.withConstructorDefault(Effect.succeed("write" as const)),
  ),
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

/**
 * The Event the engine records when the Item comes back to the state of an
 * Event whose Run was canceled: the trigger's Submission under a dedup key made
 * from the original Event's key and the reopening's number, so its Run gets an
 * id of its own and the original Event keeps its Run (#267).
 */
export const reopeningOf = (
  submission: Submission,
  original: DedupKey,
  reopening: number,
): Submission => {
  const dedupKey = DedupKey.make(JSON.stringify(["reopened", reopening, original]));
  return new Submission({
    ...submission,
    event: new Event({ ...submission.event, id: EventId.make(dedupKey), dedupKey }),
  });
};

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

/**
 * The Agent of `runId` stopped for the operator with a question or a blocker,
 * and the Event shows the Item as the stop left it, so it waits. It opens a
 * Run once the operator resolves the stop, or a later Event replaces it when
 * the Item changes again (#241, #341).
 */
export class Held extends Schema.TaggedClass<Held>("@usine/engine/Held")("Held", {
  eventId: EventId,
  runId: RunId,
}) {}

/** No Run opened because this Item requires an explicit cycle-budget reset. */
export class CycleBlocked extends Schema.TaggedClass<CycleBlocked>("@usine/engine/CycleBlocked")(
  "CycleBlocked",
  { eventId: EventId, ask: CycleBudgetAsk },
) {}

/** Whether a recorded Event owns a Run, waits behind running work or an operator hold, or can no longer open a Run. */
export const SubmissionResult = Schema.Union([Claimed, Queued, Held, Ignored, CycleBlocked]);

export type SubmissionResult = typeof SubmissionResult.Type;
