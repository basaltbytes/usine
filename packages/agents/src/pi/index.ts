/** Node-only Pi parent plus Claude child adapters. */

import { Layer } from "effect";
import { claudeChildLayer, claudeSdkLive } from "./claude.ts";
import { piParentLayer, piSdkLive } from "./pi.ts";

export * from "./claude.ts";
export * from "./pi.ts";
export * from "./subagents.ts";

const childLive = claudeChildLayer.pipe(Layer.provide(claudeSdkLive));

/** Production in-process agent runtime: Pi parent with the owned Claude child backend. */
export const layer = piParentLayer.pipe(Layer.provide(Layer.merge(piSdkLive, childLive)));
