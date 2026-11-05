import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import type { HarnessCatalog } from "./harness.ts";
import type { HarnessRuntime } from "./runtime.ts";
import { catalog } from "./catalog.ts";
import { claudeSdkLive } from "./claude/sdk.ts";
import { claudeRuntime } from "./claude/claude.ts";
import { codexAppServerLive } from "./codex/app-server.ts";
import { codexRuntime } from "./codex/codex.ts";
import { piSdkLive } from "./pi/sdk.ts";
import { piRuntime } from "./pi/pi.ts";
import { openCodeRuntime } from "./opencode/opencode.ts";
import { openCodeServerLive } from "./opencode/server.ts";
import { Harnesses } from "./registry.ts";

export { admitChild, childAdmissionContext, hostPlacement } from "./launch.ts";

export { Harnesses, HarnessRegistrationError, UnknownHarnessError } from "./registry.ts";
export { type HarnessRuntime, ProbeTarget } from "./runtime.ts";

const harnessesFor = (
  source: HarnessCatalog,
  configure: (runtimes: ReadonlyArray<HarnessRuntime>) => ReadonlyArray<HarnessRuntime>,
) =>
  Layer.unwrap(
    Effect.map(Effect.all([claudeRuntime, codexRuntime, piRuntime, openCodeRuntime]), (runtimes) =>
      Harnesses.layerFrom(source, configure(runtimes)),
    ),
  ).pipe(Layer.provide(NodeCrypto.layer));

const sdkLive = Layer.mergeAll(
  claudeSdkLive,
  codexAppServerLive,
  piSdkLive,
  openCodeServerLive.pipe(Layer.provide(NodeCrypto.layer)),
);

/** Registers every catalog descriptor with its runtime using supplied SDK services. */
export const harnessesLayer = harnessesFor(catalog, (runtimes) => runtimes);

/** Provides the registered runtimes with the production SDKs. */
export const harnessesLive = harnessesLayer.pipe(Layer.provide(sdkLive));

/** Composes raw built-in adapters before applying admission with the supplied catalog. */
export const harnessesLiveFrom = (
  source: HarnessCatalog,
  configure: (runtimes: ReadonlyArray<HarnessRuntime>) => ReadonlyArray<HarnessRuntime>,
) => harnessesFor(source, configure).pipe(Layer.provide(sdkLive));
