import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, HARNESSES, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { AgentName } from "@usine/core/agent";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Layer, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import {
  ChildBackend,
  type ChildBackendService,
  ChildRequest,
  ClaudeChildBackend,
  CodexChildBackend,
  PiChildBackend,
  SessionResult,
  WorkingDirectory,
} from "../../src/runtime.ts";
import { childDispatcherLayer } from "../../src/pi/children.ts";

const request = (harness: Harness) =>
  new ChildRequest({
    environment: { HOME: "/home/worker", PATH: "/usr/bin:/bin" },
    session: new ChildSession({
      id: AgentSessionId.make(`child-${harness}`),
      parentId: AgentSessionId.make("parent-1"),
      agent: AgentName.make("developer"),
      brain: new BrainSpec({
        harness,
        model: ModelId.make(`${harness}-model`),
        effort: "high",
      }),
    }),
    cwd: WorkingDirectory.make("/workspace/repo"),
    host: new LocalProcess(),
    prompt: "Implement the focused task.",
  });

const backend = (selected: Harness): ChildBackendService => ({
  launch: (found) =>
    Effect.succeed({
      session: found.session,
      events: Stream.empty,
      result: Effect.succeed(new SessionResult({ message: selected })),
      steer: () => Effect.void,
      interrupt: Effect.void,
      intervene: () =>
        Effect.succeed(new AttemptChannel.InterventionState({ held: false, paused: false })),
    }),
});

describe("child backend dispatcher", () => {
  it.effect("selects the backend named by the BrainSpec harness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatcher = yield* ChildBackend;
        for (const harness of HARNESSES) {
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
