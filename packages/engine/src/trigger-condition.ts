import { Context, Data, type Effect, Struct } from "effect";
import type { Submission } from "./engine/submission.ts";

const ADMISSION_SETTING_KEYS = [
  "approval",
  "approvalReason",
  "permissions",
  "ciPolicy",
  "outcomeLabels",
  "cycleLimit",
  "agent",
  "parentModel",
  "task",
] as const;

/**
 * The Loop settings and task that a queued Event's Run opens with. A recheck can replace them;
 * the Event, Item, revision, cycle generation, and CI evidence stay as recorded.
 */
export type AdmissionSettings = Pick<Submission, (typeof ADMISSION_SETTING_KEYS)[number]>;

/**
 * Returns only the Loop settings and task of `source`, such as those saved with a queued
 * submission. Every other key, such as the Event, Item, or revision, is dropped.
 */
export const savedSettings = (source: AdmissionSettings): AdmissionSettings =>
  Struct.pick(source, ADMISSION_SETTING_KEYS);

/**
 * The result of re-evaluating a queued Event's trigger:
 *
 * - `Matches`: the Item still matches, and the Event's Run opens with `settings`. Admission
 *   persists them with the Event and ignores any other key that `settings` carries.
 * - `NoLongerMatches`: the Item, Loop, or repository changed. A trigger-match mismatch revokes
 *   all queued trigger matches from the queue read before the recheck, because their condition
 *   applies to the Item. A CI fix mismatch revokes only that fix. In both cases, the next
 *   remaining queued Event is rechecked; Events arriving during the recheck stay eligible.
 * - `ItemGone`: the Item no longer exists. The queued Events are revoked, and the Item's
 *   projection is marked gone.
 * - `Undetermined`: the adapter could not read the Item's current state. A trigger match opens
 *   with its saved settings. A CI fix stays queued, and the next reconcile rechecks it.
 */
export type TriggerRecheck = Data.TaggedEnum<{
  Matches: { readonly settings: AdmissionSettings };
  NoLongerMatches: {};
  ItemGone: {};
  Undetermined: {};
}>;

export const TriggerRecheck = Data.taggedEnum<TriggerRecheck>();

/**
 * The service that re-evaluates a Loop's trigger against an Item's current state when the Run
 * ahead of a queued Event closes.
 */
export class TriggerCondition extends Context.Service<
  TriggerCondition,
  {
    /**
     * Fetches current trigger input for the queued submission and returns whether it still
     * matches, the Item is gone, or the current state could not be read.
     */
    readonly recheck: (submission: Submission) => Effect.Effect<TriggerRecheck>;
  }
>()("@usine/engine/trigger-condition/TriggerCondition") {}
