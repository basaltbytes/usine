import type { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { Effect, Layer, Stream } from "effect";
import { CurrentInstance } from "../../src/current-instance/current-instance.ts";

/** Returns a current instance that never changes; reloading it is a test bug. */
export const fixedInstance = (instance: LoadedInstance): CurrentInstance["Service"] => ({
  get: Effect.succeed(instance),
  changes: Stream.concat(Stream.make(instance), Stream.never),
  reload: Effect.die("this test's instance is never reloaded"),
  registerWorkers: () => Effect.void,
});

export const fixedInstanceLayer = (instance: LoadedInstance) =>
  Layer.succeed(CurrentInstance)(fixedInstance(instance));

/** A fixed instance with `config` and no Agents or Loops, for Worker and engine tests. */
export const fixedConfigLayer = (config: UsineConfig) =>
  fixedInstanceLayer(
    new LoadedInstance({
      config,
      agents: [],
      invalidAgents: [],
      loops: [],
      quarantinedLoops: [],
      warnings: [],
    }),
  );
