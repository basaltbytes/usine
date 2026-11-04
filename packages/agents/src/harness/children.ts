import { Effect, Layer, Option } from "effect";
import { SessionOperationError, ChildBackend } from "../runtime.ts";
import { Harnesses } from "./registry.ts";

/** Dispatches delegated tasks through the registered harness runtime. */
export const childDispatcherLayer = Layer.effect(
  ChildBackend,
  Effect.gen(function* () {
    const harnesses = yield* Harnesses;
    return ChildBackend.of({
      launch: Effect.fn("ChildBackend.launch")(function* (request) {
        const harness = request.session.brain.harness;
        yield* Effect.annotateCurrentSpan({ sessionId: request.session.id, harness });
        yield* Effect.logDebug("Dispatching child session", {
          harness,
          sessionId: request.session.id,
        });
        const runtime = yield* harnesses.runtime(harness).pipe(
          Effect.mapError((cause) =>
            SessionOperationError.make({
              operation: "launch",
              sessionId: Option.some(request.session.id),
              message: cause.message,
              cause,
            }),
          ),
        );
        return yield* runtime.launch(request);
      }),
    });
  }),
);
