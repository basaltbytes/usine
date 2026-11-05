import { Effect, Layer, Option } from "effect";
import { type ChildRequest, SessionOperationError, ChildBackend } from "../runtime.ts";
import { Harnesses } from "./registry.ts";

/** Dispatches delegated tasks through the registered harness runtime. */
export const childDispatcherLayer = Layer.effect(
  ChildBackend,
  Effect.gen(function* () {
    const harnesses = yield* Harnesses;
    const runtimeFor = (request: ChildRequest, operation: SessionOperationError["operation"]) =>
      harnesses.runtime(request.session.brain.harness).pipe(
        Effect.mapError((cause) =>
          SessionOperationError.make({
            operation,
            sessionId: Option.some(request.session.id),
            message: cause.message,
            cause,
          }),
        ),
      );
    return ChildBackend.of({
      stop: Effect.fn("ChildBackend.stop")(function* (request) {
        yield* Effect.annotateCurrentSpan({
          sessionId: request.session.id,
          harness: request.session.brain.harness,
        });
        const runtime = yield* runtimeFor(request, "interrupt");
        return yield* runtime.stop(request);
      }),
      launch: Effect.fn("ChildBackend.launch")(function* (request) {
        const harness = request.session.brain.harness;
        yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, harness });
        yield* Effect.logDebug("Dispatching child session", {
          harness,
          sessionId: request.session.id,
        });
        const runtime = yield* runtimeFor(request, "launch");
        return yield* runtime.launch(request);
      }),
    });
  }),
);
