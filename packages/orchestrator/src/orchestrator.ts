import { Context, Effect, Layer } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";
import { PollingTriggers } from "./polling-triggers.ts";
import { ScheduleTriggers } from "./schedule-triggers.ts";

const makeOrchestrator = Effect.gen(function* () {
  const polling = yield* PollingTriggers;
  const schedules = yield* ScheduleTriggers;
  const instances = yield* CurrentInstance;

  const run: Effect.Effect<never> = Effect.raceFirst(
    polling.run(instances.get),
    schedules.run(instances.get),
  );

  return { run } as const;
});

/** Coordinates polling and schedule triggers for the factory's current instance. */
export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    /** Evaluates the triggers until interrupted; each cycle reads the current instance, so a reload applies from the next one. */
    readonly run: Effect.Effect<never>;
  }
>()("@usine/orchestrator/Orchestrator") {
  static readonly layer = Layer.effect(Orchestrator, makeOrchestrator);
}
