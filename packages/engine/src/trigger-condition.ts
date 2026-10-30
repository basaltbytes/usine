import { Context, type Effect } from "effect";
import type { Submission } from "./engine/submission.ts";

/**
 * The result of re-evaluating a queued Event's trigger:
 *
 * - `matches`: the Item still matches, and the Event's Run opens.
 * - `no-longer-matches`: the Item, Loop, or repository changed, and the Item's queued Events
 *   are revoked.
 * - `item-gone`: the Item no longer exists. The queued Events are revoked, and the Item's
 *   projection is marked gone.
 */
export type TriggerRecheck = "matches" | "no-longer-matches" | "item-gone";

/**
 * The service that re-evaluates a Loop's trigger against an Item's current state when the Run
 * ahead of a queued Event closes. An adapter that can't tell returns `matches`.
 */
export class TriggerCondition extends Context.Service<
  TriggerCondition,
  {
    /**
     * Fetches current trigger input for the queued submission and returns whether it still matches
     * or the item is gone. Return `matches` when the adapter cannot determine the current state.
     */
    readonly recheck: (submission: Submission) => Effect.Effect<TriggerRecheck>;
  }
>()("@usine/engine/TriggerCondition") {}
