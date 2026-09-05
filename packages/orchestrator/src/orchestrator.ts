import type { LoadedInstance } from "@usine/config/instance";
import { Context, Effect, Layer } from "effect";
import { PollingTriggers } from "./polling-triggers.ts";
import { ScheduleTriggers } from "./schedule-triggers.ts";

const makeOrchestrator = Effect.gen(function* () {
  const polling = yield* PollingTriggers;
  const schedules = yield* ScheduleTriggers;

  const run = (instance: LoadedInstance): Effect.Effect<never> =>
    Effect.raceFirst(polling.run(instance), schedules.run(instance));

  return { run } as const;
});

/** Coordinates polling and schedule triggers for one loaded factory instance. */
export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    /** Evaluates the supplied instance's triggers until interrupted, using that snapshot of its Loops and roster. */
    readonly run: (instance: LoadedInstance) => Effect.Effect<never>;
  }
>()("@usine/orchestrator/Orchestrator") {
  static readonly layer = Layer.effect(Orchestrator, makeOrchestrator);
}
