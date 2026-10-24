import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import { WorkerName } from "@usine/core/worker";
import { Context, Effect, Layer, Schema } from "effect";

/**
 * A closed Attempt whose parent task isn't confirmed stopped. It keeps a slot of `worker` until a
 * reconcile confirms the stop (#475).
 */
export class UnconfirmedStop extends Schema.Class<UnconfirmedStop>("@usine/engine/UnconfirmedStop")(
  {
    attemptId: AttemptId,
    runId: RunId,
    worker: WorkerName,
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
