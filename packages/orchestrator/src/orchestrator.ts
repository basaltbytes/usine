import { Context, Effect, Layer } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";
import { PollingTriggers } from "./polling-triggers.ts";
import { WebhookDeliveries } from "./polling/deliveries.ts";
import { ScheduleTriggers } from "./schedule-triggers.ts";

const makeOrchestrator = Effect.gen(function* () {
  const polling = yield* PollingTriggers;
  const schedules = yield* ScheduleTriggers;
  const instances = yield* CurrentInstance;
  const deliveries = yield* WebhookDeliveries;

  const run: Effect.Effect<never> = Effect.raceAllFirst([
    polling.run(instances),
    schedules.run(instances),
    deliveries.run(instances),
  ]);

  return { run } as const;
});

/** Coordinates polling and schedule triggers for the factory's current instance. */
export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    /**
     * Evaluates the triggers until interrupted. Each cycle reads the current instance, and an
     * accepted reload starts the next poll and schedule evaluation immediately.
     */
    readonly run: Effect.Effect<never>;
  }
>()("@usine/orchestrator/Orchestrator") {
  /**
   * Provides the trigger coordinator, including webhook delivery hints, using the supplied current
   * instance and trigger services.
   */
  static readonly layer = Layer.effect(Orchestrator, makeOrchestrator).pipe(
    Layer.provide(WebhookDeliveries.layer),
  );
}
