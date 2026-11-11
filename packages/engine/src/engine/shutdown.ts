import { Context, Deferred } from "effect";

/**
 * An optional shutdown latch owned by the host, provided before building an engine runtime.
 * Completing it closes Attempt admission, even during startup recovery. It can't be reopened,
 * so each runtime needs a new one.
 */
export class RunEngineShutdown extends Context.Service<
  RunEngineShutdown,
  Deferred.Deferred<void>
>()("@usine/engine/engine/shutdown/RunEngineShutdown") {}
