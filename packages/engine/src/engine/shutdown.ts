import { Context, Deferred } from "effect";

/**
 * Optional host-owned shutdown latch, provided before building an engine runtime.
 * Completing it closes Attempt admission even while startup recovery is running.
 * After startup, RunEngine.drain waits for admitted Attempts to persist their outcomes.
 * Allocate a fresh latch for each runtime; it cannot be reopened (ADR 0023).
 */
export class RunEngineShutdown extends Context.Service<
  RunEngineShutdown,
  Deferred.Deferred<void>
>()("@usine/engine/RunEngineShutdown") {}
