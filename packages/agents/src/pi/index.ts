/** Node-only Pi parent plus all harness child adapters. */

import { Layer } from "effect";
import { claudeChildBackendLayer, claudeSdkLive } from "./claude.ts";
import { childDispatcherLayer } from "./children.ts";
import { codexAppServerLive, codexChildBackendLayer } from "./codex.ts";
import { piChildBackendLayer, piParentLayer, piSdkLive } from "./pi.ts";

export * from "./claude.ts";
export * from "./children.ts";
export * from "./codex.ts";
export * from "./pi.ts";
export * from "./subagents.ts";

const childImplementations = Layer.merge(
  claudeChildBackendLayer.pipe(Layer.provide(claudeSdkLive)),
  Layer.merge(
    codexChildBackendLayer.pipe(Layer.provide(codexAppServerLive)),
    piChildBackendLayer.pipe(Layer.provide(piSdkLive)),
  ),
);
const childLive = childDispatcherLayer.pipe(Layer.provide(childImplementations));

/** Production in-process agent runtime: Pi parent with the three harness child backends. */
export const layer = piParentLayer.pipe(Layer.provide(Layer.merge(piSdkLive, childLive)));
