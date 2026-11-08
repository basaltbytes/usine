import { Context, Data, type Effect } from "effect";
import type { Submission } from "./engine/submission.ts";

/**
 * The result of re-evaluating a queued Event's trigger:
 *
 * - `Matches`: the Item still matches, and the Event's Run opens with `submission`. The adapter
 *   may replace the Loop settings saved with the Event, such as approval or Agent, and the task
 *   to reflect the Loop's current configuration. Admission persists these settings and the task
 *   for execution; the Event, Item, and CI evidence stay as recorded.
 * - `NoLongerMatches`: the Item, Loop, or repository changed. This Event is revoked, and the
 *   next queued Event is rechecked.
 * - `ItemGone`: the Item no longer exists. The queued Events are revoked, and the Item's
 *   projection is marked gone.
 */
export type TriggerRecheck = Data.TaggedEnum<{
  Matches: { readonly submission: Submission };
  NoLongerMatches: {};
  ItemGone: {};
}>;

export const TriggerRecheck = Data.taggedEnum<TriggerRecheck>();

/**
 * The service that re-evaluates a Loop's trigger against an Item's current state when the Run
 * ahead of a queued Event closes. An adapter that can't tell returns `Matches` with the queued
 * submission.
 */
export class TriggerCondition extends Context.Service<
  TriggerCondition,
  {
    /**
     * Fetches current trigger input for the queued submission and returns whether it still matches
     * or the item is gone. Returns `Matches` when the adapter cannot determine the current state.
     */
    readonly recheck: (submission: Submission) => Effect.Effect<TriggerRecheck>;
  }
>()("@usine/engine/trigger-condition/TriggerCondition") {}
