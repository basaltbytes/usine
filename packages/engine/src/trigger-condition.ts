import { Context, type Effect } from "effect";
import type { Submission } from "./engine/submission.ts";

/**
 * Re-evaluates a Loop's trigger against an Item's current state. The engine
 * consults it for a queued Event when the Run ahead of it closes: the poll
 * that recorded the Event may predate that Run's own writes, such as the
 * label swap a finisher makes after its push. `false` records the Event as
 * ignored (revoked) and opens nothing; `true` opens its Run as usual. An
 * adapter that cannot tell answers `true`, so the Run opens as it did before
 * the check existed.
 */
export class TriggerCondition extends Context.Service<
  TriggerCondition,
  {
    readonly holds: (submission: Submission) => Effect.Effect<boolean>;
  }
>()("@usine/engine/TriggerCondition") {}
