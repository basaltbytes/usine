import { AttemptId, StopReason } from "@usine/core/attempt";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Context, Effect, Layer, Schema } from "effect";

/**
 * An attempt whose parent task stop is pending or unconfirmed. No loop starts a new attempt on
 * `itemKey` until the stop succeeds. A failed stop also reserves a slot of `worker`.
 * `reason` is why the engine stops the parent task, which each retry passes to the executor.
 */
export class UnconfirmedStop extends Schema.Class<UnconfirmedStop>("@usine/engine/UnconfirmedStop")(
  {
    /** The attempt whose parent task has not been confirmed stopped. */
    attemptId: AttemptId,
    /** The run that owns the attempt, including runs already closed. */
    runId: RunId,
    /** The qualified loop identity recorded for the attempt. */
    loop: LoopName,
    /** The item on which new attempts must wait for this stop. */
    itemKey: ItemKey,
    /** The worker whose slot remains reserved after a failed stop. */
    worker: WorkerName,
    /** The stop reason passed to the executor again on each reconciliation. */
    reason: StopReason,
  },
) {}

/** Lists pending parent stops and failed stops that reconciliation retries. */
export class UnconfirmedStops extends Context.Service<
  UnconfirmedStops,
  {
    /** Returns attempts in the order their stop was first requested. */
    readonly list: Effect.Effect<ReadonlyArray<UnconfirmedStop>>;
  }
>()("@usine/engine/UnconfirmedStops") {
  /** Lists no Attempt, for a process that drives no Run, as in setup mode. */
  static readonly empty = Layer.succeed(UnconfirmedStops)({ list: Effect.succeed([]) });
}
