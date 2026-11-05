import { Effect, Layer } from "effect";
import { catalog } from "./catalog.ts";
import { claudeSdkLive } from "./claude/sdk.ts";
import { claudeRuntime } from "./claude/claude.ts";
import { codexAppServerLive } from "./codex/app-server.ts";
import { codexRuntime } from "./codex/codex.ts";
import { piSdkLive } from "./pi/sdk.ts";
import { piRuntime } from "./pi/pi.ts";
import { Harnesses } from "./registry.ts";

export { admitChild, childAdmissionContext, hostPlacement } from "./launch.ts";

export { Harnesses, HarnessRegistrationError, UnknownHarnessError } from "./registry.ts";
export { type HarnessRuntime, ProbeTarget } from "./runtime.ts";

/** Registers every catalog descriptor with its runtime using supplied SDK services. */
export const harnessesLayer = Layer.unwrap(
  Effect.map(Effect.all([claudeRuntime, codexRuntime, piRuntime]), (runtimes) =>
    Harnesses.layerFrom(catalog, runtimes),
  ),
);

/** Provides the registered runtimes with the production SDKs. */
export const harnessesLive = harnessesLayer.pipe(
  Layer.provide(Layer.mergeAll(claudeSdkLive, codexAppServerLive, piSdkLive)),
);
