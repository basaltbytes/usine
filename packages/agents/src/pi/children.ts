import { Effect, Layer } from "effect";
import { ChildBackend, ClaudeChildBackend, CodexChildBackend, PiChildBackend } from "../runtime.ts";

const makeChildDispatcher = Effect.gen(function* () {
  const claude = yield* ClaudeChildBackend;
  const codex = yield* CodexChildBackend;
  const pi = yield* PiChildBackend;

  return ChildBackend.of({
    launch: Effect.fn("ChildBackend.launch")(function* (request) {
      yield* Effect.logDebug("Dispatching child session", {
        harness: request.session.brain.harness,
        sessionId: request.session.id,
      });
      switch (request.session.brain.harness) {
        case "claude":
          return yield* claude.launch(request);
        case "codex":
          return yield* codex.launch(request);
        case "pi":
          return yield* pi.launch(request);
      }
    }),
  });
});

/** Selects one concrete child backend from the authored BrainSpec harness. */
export const childDispatcherLayer = Layer.effect(ChildBackend, makeChildDispatcher);
