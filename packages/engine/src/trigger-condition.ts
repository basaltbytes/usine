import { Context, type Effect } from "effect";
import type { Submission } from "./engine/submission.ts";

/**
 * What re-evaluating a queued Event's trigger found:
 * - `matches`: the Item still matches, and the Event's Run opens.
 * - `no-longer-matches`: the Item, its Loop, or its repository moved on, and
 *   the Item's queued Events are recorded as ignored (revoked).
 * - `item-gone`: the Item's source no longer has it. The queued Events are
 *   revoked as for `no-longer-matches`, and the Item's Board projection is
 *   marked gone so its card leaves the open lanes.
 */
export type TriggerRecheck = "matches" | "no-longer-matches" | "item-gone";

/**
 * Re-evaluates a Loop's trigger against an Item's current state. The engine
 * consults it for a queued Event when the Run ahead of it closes: the poll
 * that recorded the Event may predate that Run's own writes, such as the
 * label swap a finisher makes after its push. An adapter that cannot tell
 * answers `matches`, so the Run opens as it did before the check existed.
 */
export class TriggerCondition extends Context.Service<
  TriggerCondition,
  {
    readonly recheck: (submission: Submission) => Effect.Effect<TriggerRecheck>;
  }
>()("@usine/engine/TriggerCondition") {}
