import { Effect, Layer, Option } from "effect";
import {
  SessionOperationError,
  ChildBackend,
  ClaudeChildBackend,
  CodexChildBackend,
  PiChildBackend,
} from "../runtime.ts";

const makeChildDispatcher = Effect.gen(function* () {
  const claude = yield* ClaudeChildBackend;
  const codex = yield* CodexChildBackend;
  const pi = yield* PiChildBackend;

  return ChildBackend.of({
    launch: Effect.fn("ChildBackend.launch")(function* (request) {
      yield* Effect.annotateCurrentSpan({
        sessionId: request.session.id,
        harness: request.session.brain.harness,
      });
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
        default:
          return yield* SessionOperationError.make({
            operation: "launch",
            sessionId: Option.some(request.session.id),
            message: `No child runtime for harness "${request.session.brain.harness}"`,
            cause: new Error("Unknown harness runtime"),
          });
      }
    }),
  });
});

/** Dispatches each delegated task to the Claude Code, Codex, or Pi backend according to the Agent's harness; requires all three backend layers. */
export const childDispatcherLayer = Layer.effect(ChildBackend, makeChildDispatcher);
