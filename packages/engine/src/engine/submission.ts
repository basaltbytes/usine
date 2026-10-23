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

/** A matched Event with its Loop, Item, and Run settings. */
export class Submission extends Schema.Class<Submission>("@usine/engine/Submission")({
  event: Event,
  itemKey: ItemKey,
  loop: LoopName,
  step: StepName,
  approval: ApprovalRequirement,
  /** The repository access of the Run's Attempts, from the Loop at match time. */
  permissions: LoopPermissions.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("write" as const)),
    Schema.withConstructorDefault(Effect.succeed("write" as const)),
  ),
  /** The cycle limit; schedule triggers set `None`. */
  cycleLimit: Schema.Option(CycleLimit).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(Option.some(DEFAULT_CYCLE_LIMIT))),
    Schema.withConstructorDefault(Effect.succeed(Option.some(DEFAULT_CYCLE_LIMIT))),
  ),
  /** The Item's cycle generation, read before fetching trigger input. */
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

// Older Runs used this Effect workflow execution ID; hashing the same input keeps Run IDs stable.
const RUN_ID_NAMESPACE = "@usine/engine/DurableRun";

/** Returns the Run ID for the Submission's Event: the first 16 bytes, in hex, of the SHA-256 of its namespaced dedup key. */
export const runIdFor = Effect.fn("Submission.runIdFor")(function* (submission: Submission) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`${RUN_ID_NAMESPACE}-${submission.event.dedupKey}`))
    .pipe(Effect.orDie);
  return RunId.make(Encoding.encodeHex(digest.subarray(0, 16)));
});

/**
 * Returns the Submission recorded when the Item returns to the state of an Event whose Run was
 * canceled. Its dedup key combines the original key and the reopening number, so the new Run
 * gets its own ID (#267).
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

/** A result for an Event that has a Run; submitting it again returns the same Run ID. */
export class Claimed extends Schema.TaggedClass<Claimed>("@usine/engine/Claimed")("Claimed", {
  eventId: EventId,
  runId: RunId,
}) {}

/** A result for an Event that waits until a running Attempt on the same Item finishes. */
export class Queued extends Schema.TaggedClass<Queued>("@usine/engine/Queued")("Queued", {
  eventId: EventId,
}) {}

export const IGNORED_REASONS = ["superseded", "revoked"] as const;

export const IgnoreReason = Schema.Literals(IGNORED_REASONS);

export type IgnoreReason = typeof IgnoreReason.Type;

/** A result for an Event that is recorded but can't open a Run. */
export class Ignored extends Schema.TaggedClass<Ignored>("@usine/engine/Ignored")("Ignored", {
  eventId: EventId,
  reason: IgnoreReason,
}) {}

/**
 * A result for an Event that waits because the Agent of `runId` stopped with a question or
 * blocker. It opens a Run once the operator resolves the stop, or a later Event replaces it when
 * the Item changes (#241, #341).
 */
export class Held extends Schema.TaggedClass<Held>("@usine/engine/Held")("Held", {
  eventId: EventId,
  runId: RunId,
}) {}

/** A result for an Event that opened no Run because the Item needs a cycle-budget reset. */
export class CycleBlocked extends Schema.TaggedClass<CycleBlocked>("@usine/engine/CycleBlocked")(
  "CycleBlocked",
  { eventId: EventId, ask: CycleBudgetAsk },
) {}

export const SubmissionResult = Schema.Union([Claimed, Queued, Held, Ignored, CycleBlocked]);

export type SubmissionResult = typeof SubmissionResult.Type;
