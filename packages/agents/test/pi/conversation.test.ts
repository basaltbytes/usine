import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession, ParentSession } from "@usine/core/agent/session";
import { Interrupt, OperatorMessage, Release, Steer } from "@usine/core/attempt/channel";
import { Deferred, Effect, Fiber } from "effect";
import { AgentResultError } from "../../src/runtime.ts";
import { sessionChannel } from "../../src/pi/session.ts";
import { sessionConversation } from "../../src/pi/conversation.ts";

const parent = new ParentSession({
  id: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain: new BrainSpec({ harness: "pi", model: ModelId.make("openai/model"), effort: "medium" }),
});
const child = (id: string) =>
  new ChildSession({
    id: AgentSessionId.make(id),
    parentId: parent.id,
    agent: parent.agent,
    brain: parent.brain,
  });
const conversation = (session: ChildSession) =>
  Effect.gen(function* () {
    const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
    const turns: Array<{ message: string; activity: "idle" | "running" }> = [];
    const controls = yield* sessionConversation({
      session,
      channel,
      send: (message, activity) =>
        Effect.sync(() => {
          turns.push({ message, activity });
        }),
      pause: Effect.void,
      beforeFinish: Effect.void,
    });
    const result = yield* Deferred.await(channel.result).pipe(Effect.forkChild);
    return { ...controls, result, turns };
  });

describe("session supervision", () => {
  it.effect("fails a held child's unresolved blocker only when the operator releases it", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("blocked"));
      yield* session.intervene(new OperatorMessage({ message: "Investigate permissions" }));
      yield* session.finish("[usine:blocked]\r\nPublishing permission denied.");
      assert.strictEqual(session.result.pollUnsafe(), undefined);
      yield* session.intervene(new Release());
      const error = yield* Fiber.join(session.result).pipe(Effect.flip);
      assert(error instanceof AgentResultError);
      assert.strictEqual(error.message, "Publishing permission denied.");
    }),
  );

  it.effect("allows an operator to resolve a held blocker before completion", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("resolved"));
      yield* session.intervene(new OperatorMessage({ message: "Investigate permissions" }));
      yield* session.finish("[usine:blocked]\nPermission denied.");
      yield* session.intervene(
        new OperatorMessage({ message: "Permission granted; finish publishing" }),
      );
      yield* session.finish("Published. The earlier [usine:blocked] outcome is resolved.");
      yield* session.intervene(new Release());
      assert.strictEqual(
        (yield* Fiber.join(session.result)).message,
        "Published. The earlier [usine:blocked] outcome is resolved.",
      );
    }),
  );

  it.effect("fails a blocker whose details share the marker's line", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("same-line"));
      yield* session.finish("[usine:blocked] Repository permission denied.");
      const error = yield* Fiber.join(session.result).pipe(Effect.flip);
      assert(error instanceof AgentResultError);
      assert.strictEqual(error.message, "Repository permission denied.");
    }),
  );

  it.effect("fails a blocker marker even when the agent omits its details", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("no-details"));
      yield* session.finish("[usine:blocked]");
      const error = yield* Fiber.join(session.result).pipe(Effect.flip);
      assert(error instanceof AgentResultError);
      assert.match(error.message, /without details/u);
    }),
  );

  it.effect(
    "keeps independent child Holds addressable while another session is parked at a boundary",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* conversation(child("coordinator"));
        const first = yield* conversation(child("first"));
        const second = yield* conversation(child("second"));
        yield* coordinator.intervene(new Interrupt());
        const boundary = yield* coordinator.awaitUnpaused.pipe(Effect.forkChild);
        yield* first.intervene(new OperatorMessage({ message: "Check this" }));
        yield* second.intervene(new OperatorMessage({ message: "Check that" }));
        yield* first.finish("First result");
        yield* second.finish("Second result");
        assert.strictEqual(first.result.pollUnsafe(), undefined);
        assert.strictEqual(second.result.pollUnsafe(), undefined);
        yield* first.intervene(new Release());
        assert.strictEqual((yield* Fiber.join(first.result)).message, "First result");
        assert.strictEqual(second.result.pollUnsafe(), undefined);
        assert.strictEqual(boundary.pollUnsafe(), undefined);
        yield* second.intervene(new OperatorMessage({ message: "Revise it" }));
        assert.deepStrictEqual(second.turns.at(-1), { message: "Revise it", activity: "idle" });
        yield* second.finish("Revised result");
        yield* second.intervene(new Release());
        assert.strictEqual((yield* Fiber.join(second.result)).message, "Revised result");
        const resumed = yield* coordinator.intervene(new Steer({ message: "Continue" }));
        assert.deepStrictEqual([resumed.held, resumed.paused], [false, false]);
        yield* Fiber.join(boundary);
        yield* coordinator.finish("Coordinator result");
        assert.strictEqual((yield* Fiber.join(coordinator.result)).message, "Coordinator result");
      }),
  );

  it.effect("resumes a paused child with one-shot steering without creating a takeover Hold", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("steered"));
      yield* session.intervene(new Interrupt());
      yield* session.finish("Paused turn");
      const state = yield* session.intervene(
        new Steer({ message: "Continue with the correction" }),
      );
      assert.deepStrictEqual([state.held, state.paused], [false, false]);
      yield* session.finish("Corrected result");
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Corrected result");
    }),
  );
});
