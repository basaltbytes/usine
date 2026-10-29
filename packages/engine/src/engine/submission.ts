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
import { Crypto, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";

/** A matched Event with its Loop, Item, and Run settings. */
export class Submission extends Schema.Class<Submission>("@usine/engine/Submission")({
  /**
   * The trigger match and its dedup key, recorded before the engine decides whether to open a run.
   */
  event: Event,
  /** The item identity used to serialize runs of this loop and apply its cycle budget. */
  itemKey: ItemKey,
  /** The qualified loop identity for the match. */
  loop: LoopName,
  /** The name under which the run stores its agent action result. */
  step: StepName,
  /** Whether the run must wait for an operator approval before execution. */
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
  /** The managed repo checked out for attempts of this run. */
  repository: RepositoryName,
  /** The repository revision to resolve when preparing an attempt checkout. */
  revision: RepositoryRevision,
  /** The rendered loop task for the run, before any edit-and-retry amendment. */
  task: AttemptTask,
  /** The agent definition saved at match time for the run. */
  agent: Agent,
  /** The requested Pi parent model, or `None` to use the runtime default. */
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
  return RunId.make(Hex.encode(digest.subarray(0, 16)));
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
  /** The recorded event associated with the run. */
  eventId: EventId,
  /** The opened or previously claimed run; repeated submissions return this same ID. */
  runId: RunId,
}) {}

/** A result for an Event that waits until a running Attempt on the same Item finishes. */
export class Queued extends Schema.TaggedClass<Queued>("@usine/engine/Queued")("Queued", {
  /** The recorded event waiting behind an active attempt on this loop and item. */
  eventId: EventId,
}) {}

export const IGNORED_REASONS = ["superseded", "revoked"] as const;

/**
 * Why an event cannot open a run: `superseded` means a newer event or cycle generation replaced
 * it; `revoked` means its item stopped matching.
 */
export const IgnoreReason = Schema.Literals(IGNORED_REASONS);

export type IgnoreReason = typeof IgnoreReason.Type;

/** A result for an Event that is recorded but can't open a Run. */
export class Ignored extends Schema.TaggedClass<Ignored>("@usine/engine/Ignored")("Ignored", {
  /** The recorded event that cannot open a run. */
  eventId: EventId,
  /** Why this event was superseded or revoked; see `IgnoreReason`. */
  reason: IgnoreReason,
}) {}

/**
 * A result for an Event that waits because the Agent of `runId` stopped with a question or
 * blocker. It opens a Run once the operator resolves the stop, or a later Event replaces it when
 * the Item changes (#241, #341).
 */
export class Suppressed extends Schema.TaggedClass<Suppressed>("@usine/engine/Suppressed")(
  "Suppressed",
  {
    /** The event waiting for suppression to end. */
    eventId: EventId,
    /** The run whose unresolved question or blocker suppresses the item. */
    runId: RunId,
  },
) {}

/** A result for an Event that opened no Run because the Item needs a cycle-budget reset. */
export class CycleBlocked extends Schema.TaggedClass<CycleBlocked>("@usine/engine/CycleBlocked")(
  "CycleBlocked",
  {
    /** The event that could not open a run within the cycle budget. */
    eventId: EventId,
    /** The open ask that the operator must reset before further admission. */
    ask: CycleBudgetAsk,
  },
) {}

/**
 * The outcome of recording a trigger match: its run, queued event, suppression, ignore reason, or
 * cycle-budget ask.
 */
export const SubmissionResult = Schema.Union([Claimed, Queued, Suppressed, Ignored, CycleBlocked]);

export type SubmissionResult = typeof SubmissionResult.Type;
