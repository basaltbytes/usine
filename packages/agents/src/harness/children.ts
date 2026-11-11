import { Effect, Layer, Option } from "effect";
import { type ChildRequest, SessionOperationError, ChildBackend } from "../runtime.ts";
import { childContinuation } from "./continuation.ts";
import { Harnesses } from "./registry.ts";

/** Dispatches delegated tasks through the registered harness runtime, admitted with its catalog. */
export const childDispatcherLayer = Layer.effect(
  ChildBackend,
  Effect.gen(function* () {
    const harnesses = yield* Harnesses;
    const childrenFor = (request: ChildRequest, operation: SessionOperationError["operation"]) =>
      harnesses.runtime(request.session.brain.harness).pipe(
        Effect.mapBoth({
          onSuccess: (runtime) => childContinuation(harnesses.catalog, runtime),
          onFailure: (cause) =>
            SessionOperationError.make({
              operation,
              sessionId: Option.some(request.session.id),
              message: cause.message,
              cause,
            }),
        }),
      );
    return ChildBackend.of({
      stop: Effect.fn("ChildBackend.stop")(function* (request) {
        yield* Effect.annotateCurrentSpan({
          sessionId: request.session.id,
          harness: request.session.brain.harness,
        });
        const children = yield* childrenFor(request, "interrupt");
        return yield* children.stop(request);
      }),
      launch: Effect.fn("ChildBackend.launch")(function* (request) {
        const harness = request.session.brain.harness;
        yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, harness });
        yield* Effect.logDebug("Dispatching child session", {
          harness,
          sessionId: request.session.id,
        });
        const children = yield* childrenFor(request, "launch");
        return yield* children.launch(request);
      }),
    });
  }),
);
