import { AttemptId, StopReason } from "@usine/core/attempt";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Context, Effect, Layer, Schema } from "effect";

/**
 * A closed Attempt whose parent task isn't confirmed stopped. It keeps a slot of `worker`, and no
 * Run of `loop` on `itemKey` starts an Attempt, until a reconcile confirms the stop (#475, #523).
 * `reason` is why the engine stops the parent task, which each retry passes to the executor.
 */
export class UnconfirmedStop extends Schema.Class<UnconfirmedStop>("@usine/engine/UnconfirmedStop")(
  {
    attemptId: AttemptId,
    runId: RunId,
    loop: LoopName,
    itemKey: ItemKey,
    worker: WorkerName,
    reason: StopReason,
  },
) {}

/** The service that lists the closed Attempts whose parent task stop each reconcile retries. */
export class UnconfirmedStops extends Context.Service<
  UnconfirmedStops,
  {
    /** Returns the Attempts in the order their stop first failed. */
    readonly list: Effect.Effect<ReadonlyArray<UnconfirmedStop>>;
  }
>()("@usine/engine/UnconfirmedStops") {
  /** Lists no Attempt, for a process that drives no Run, as in setup mode. */
  static readonly empty = Layer.succeed(UnconfirmedStops)({ list: Effect.succeed([]) });
}
