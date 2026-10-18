import type { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { Effect, Layer } from "effect";
import { CurrentInstance } from "../../src/current-instance/current-instance.ts";

/** A current instance that never changes; a test that reloads it has a bug. */
export const fixedInstanceLayer = (instance: LoadedInstance) =>
  Layer.succeed(CurrentInstance)({
    get: Effect.succeed(instance),
    reload: Effect.die("this test's instance is never reloaded"),
  });

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
