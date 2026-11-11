import { type Brand, Context, Effect, Layer, type Option, Schema } from "effect";

import {
  type AttemptContext,
  type CoordinatorEvent,
  Decision,
} from "../attempt/coordinator/rules.ts";

/** What answered an event: the event's rule, a model over an API endpoint, or a harness session. */
export const DecisionHandler = Schema.Literals(["rule", "endpoint", "harness"]);
export type DecisionHandler = typeof DecisionHandler.Type;

/** The decision recorded for one event, with the handler that made it. */
export class RecordedDecision extends Schema.Class<
  RecordedDecision,
  Brand.Brand<"@usine/durable/coordinator/wake-up/RecordedDecision">
>("@usine/durable/RecordedDecision")({
  decision: Decision,
  handler: DecisionHandler,
}) {}

/**
 * Wakes one handler for each lifecycle event of an event-driven Attempt. The coordinator records
 * the handler's decision, then checks it with `clamp`, whatever handled it.
 */
export class WakeUp extends Context.Service<
  WakeUp,
  {
    /**
     * Returns one decision for `event`, or `None` to apply the event's rule. Never fails the
     * Attempt: a handler that can't decide returns `None`.
     */
    readonly handle: (
      event: CoordinatorEvent,
      context: AttemptContext,
    ) => Effect.Effect<Option.Option<RecordedDecision>>;
  }
>()("@usine/durable/coordinator/wake-up/WakeUp") {
  /** Sends every event to its rule. */
  static readonly rules = Layer.succeed(WakeUp, WakeUp.of({ handle: () => Effect.succeedNone }));
}
