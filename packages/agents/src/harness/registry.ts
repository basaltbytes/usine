import { Harness } from "@usine/core/agent/brain";
import { type Brand, Context, Effect, Layer, Option, Schema } from "effect";
import { HarnessCatalog } from "./harness.ts";
import { admitPreflight, type HarnessRuntime } from "./runtime.ts";
import { ChildRequest } from "../runtime.ts";
import { admitChild } from "./launch.ts";

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

/** A complete catalog of harness descriptors and their runtimes. */
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
      registered.set(runtime.id, {
        id: runtime.id,
        stop: (request) =>
          runtime.stop(
            ChildRequest.make({
              ...request,
              environment: catalog.environmentFor(runtime.id, request.environment),
            }),
          ),
        launch: (request) => {
          const scoped = ChildRequest.make({
            ...request,
            environment: catalog.environmentFor(runtime.id, request.environment),
          });
          return admitChild(catalog, scoped).pipe(Effect.andThen(() => runtime.launch(scoped)));
        },
        resume: (request, reference) => {
          const scoped = ChildRequest.make({
            ...request,
            resume: Option.some(reference),
            environment: catalog.environmentFor(runtime.id, request.environment),
          });
          return admitChild(catalog, scoped).pipe(
            Effect.andThen(() => runtime.resume(scoped, reference)),
          );
        },
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
