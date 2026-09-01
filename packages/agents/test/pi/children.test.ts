import { assert, describe, it } from "@effect/vitest";
import { Agent } from "@usine/core";
import { Effect, Layer, Stream } from "effect";
import {
  ChildBackend,
  ChildRequest,
  ClaudeChildBackend,
  CodexChildBackend,
  PiChildBackend,
  SessionResult,
  WorkingDirectory,
  type ChildBackendService,
} from "../../src/index.ts";
import { childDispatcherLayer } from "../../src/pi/children.ts";

const request = (harness: Agent.Harness) =>
  new ChildRequest({
    session: new Agent.ChildSession({
      id: Agent.SessionId.make(`child-${harness}`),
      parentId: Agent.SessionId.make("parent-1"),
      agent: Agent.Name.make("developer"),
      brain: new Agent.BrainSpec({
        harness,
        model: Agent.ModelId.make(`${harness}-model`),
        effort: "high",
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/repo"),
    prompt: "Implement the focused task.",
  });

const backend = (selected: Agent.Harness): ChildBackendService => ({
  launch: (found) =>
    Effect.succeed({
      session: found.session,
      events: Stream.empty,
      result: Effect.succeed(new SessionResult({ message: selected })),
      steer: () => Effect.void,
      interrupt: Effect.void,
    }),
});

describe("child backend dispatcher", () => {
  it.effect("selects the backend named by the BrainSpec harness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatcher = yield* ChildBackend;
        for (const harness of Agent.HARNESSES) {
          const running = yield* dispatcher.launch(request(harness));
          const result = yield* running.result;
          assert.strictEqual(result.message, harness);
        }
      }).pipe(
        Effect.provide(childDispatcherLayer),
        Effect.provide(Layer.succeed(ClaudeChildBackend)(backend("claude"))),
        Effect.provide(Layer.succeed(CodexChildBackend)(backend("codex"))),
        Effect.provide(Layer.succeed(PiChildBackend)(backend("pi"))),
      ),
    ),
  );
});
