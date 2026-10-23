import { Context, Deferred } from "effect";

/**
 * An optional shutdown latch owned by the host, provided before building an engine runtime.
 * Completing it closes Attempt admission, even during startup recovery. It can't be reopened,
 * so each runtime needs a new one (ADR 0023).
 */
export class RunEngineShutdown extends Context.Service<
  RunEngineShutdown,
  Deferred.Deferred<void>
>()("@usine/engine/RunEngineShutdown") {}
