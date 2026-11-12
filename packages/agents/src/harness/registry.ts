import { Harness } from "@usine/core/agent/brain";
import { type Brand, Context, Effect, Layer, Option, Schema } from "effect";
import { HarnessCatalog } from "./harness.ts";
import { admitPreflight, type HarnessRuntime } from "./runtime.ts";
import { SessionSpec } from "./contract.ts";
import { admitSession } from "./launch.ts";
import { admitCompletion } from "./completion.ts";

/** A descriptor and its runtime cannot be registered together. */
export class HarnessRegistrationError extends Schema.TaggedError<
  HarnessRegistrationError,
  Brand.Brand<"@usine/agents/HarnessRegistrationError">
>("@usine/agents/HarnessRegistrationError")("HarnessRegistrationError", {
  harness: Harness,
  message: Schema.NonEmptyString,
}) {}

/** A requested harness has no registered runtime. */
export class UnknownHarnessError extends Schema.TaggedError<
  UnknownHarnessError,
  Brand.Brand<"@usine/agents/UnknownHarnessError">
>("@usine/agents/UnknownHarnessError")("UnknownHarnessError", {
  harness: Harness,
  message: Schema.NonEmptyString,
}) {}

/**
 * A complete catalog of harness descriptors and their runtimes. Each registered runtime opens and
 * stops sessions and runs completions with only its own harness's host variables, and admits each
 * opened session, completion, and preflight brain with the catalog.
 */
export class Harnesses extends Context.Service<
  Harnesses,
  {
    readonly catalog: HarnessCatalog;
    readonly runtime: (id: Harness) => Effect.Effect<HarnessRuntime, UnknownHarnessError>;
  }
>()("@usine/agents/harness/registry/Harnesses") {
  private static readonly make = Effect.fn("Harnesses.make")(function* (
    catalog: HarnessCatalog,
    runtimes: ReadonlyArray<HarnessRuntime>,
  ) {
    const registered = new Map<Harness, HarnessRuntime>();
    for (const runtime of runtimes) {
      const message = registered.has(runtime.id)
        ? `Duplicate runtime for harness "${runtime.id}"`
        : Option.isNone(catalog.get(runtime.id))
          ? `No descriptor for harness runtime "${runtime.id}"`
          : undefined;
      if (message !== undefined) {
        yield* Effect.logError("Harness registration failed", { harness: runtime.id, message });
        return yield* HarnessRegistrationError.make({ harness: runtime.id, message });
      }
      const scoped = (spec: SessionSpec) =>
        SessionSpec.make({
          ...spec,
          environment: catalog.environmentFor(runtime.id, spec.environment),
        });
      registered.set(runtime.id, {
        id: runtime.id,
        stop: (spec) => runtime.stop(scoped(spec)),
        open: (spec, start, continuation, tools) =>
          admitSession(catalog, spec, start, tools !== undefined).pipe(
            Effect.andThen(() => runtime.open(scoped(spec), start, continuation, tools)),
          ),
        complete: (spec, prompt, output) =>
          admitCompletion(catalog, spec, output).pipe(
            Effect.andThen(() => runtime.complete(scoped(spec), prompt, output)),
          ),
        preflight: (brain, target) =>
          admitPreflight(catalog, brain, target).pipe(
            Effect.andThen(() => runtime.preflight(brain, target)),
            Effect.catchTag("HarnessUnavailableError", (error) => Effect.succeed(error)),
          ),
      });
    }
    for (const id of catalog.ids) {
      if (!registered.has(id)) {
        const message = `No runtime for harness descriptor "${id}"`;
        yield* Effect.logError("Harness registration failed", { harness: id, message });
        return yield* HarnessRegistrationError.make({ harness: id, message });
      }
    }
    yield* Effect.logDebug("Registered harness runtimes", { harnesses: catalog.ids.join(",") });
    return Harnesses.of({
      catalog,
      runtime: Effect.fn("Harnesses.runtime")(function* (id) {
        yield* Effect.annotateCurrentSpan({ harness: id });
        const runtime = registered.get(id);
        if (runtime !== undefined) return runtime;
        yield* Effect.logWarning("Harness runtime is unavailable", { harness: id });
        return yield* UnknownHarnessError.make({
          harness: id,
          message: `No runtime for harness "${id}"`,
        });
      }),
    });
  });

  static readonly layerFrom = (catalog: HarnessCatalog, runtimes: ReadonlyArray<HarnessRuntime>) =>
    Layer.effect(Harnesses, Harnesses.make(catalog, runtimes));
}
