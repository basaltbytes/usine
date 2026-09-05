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

/** The embeddable full runtime: polling, schedules, engine-facing operator acts. */
export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    readonly run: (instance: LoadedInstance) => Effect.Effect<never>;
  }
>()("@usine/orchestrator/Orchestrator") {
  static readonly layer = Layer.effect(Orchestrator, makeOrchestrator);
}
