import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession, ParentSession } from "@usine/core/agent/session";
import {
  Interrupt,
  type InterventionState,
  OperatorMessage,
  Release,
  Steer,
} from "@usine/core/attempt/channel";
import { Deferred, Effect, Exit, Fiber, Option, Queue, Scope } from "effect";
import { AgentBlockedError, AgentQuestionError, type OnDelivery } from "../../src/runtime.ts";
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
      // A message to a running turn waits for the harness's next boundary.
      send: (message, activity) =>
        Effect.sync(() => {
          turns.push({ message, activity });
          return activity === "idle" ? ("read" as const) : ("queued" as const);
        }),
      pause: Effect.void,
      beforeFinish: Effect.void,
    });
    const result = yield* Deferred.await(channel.result).pipe(Effect.forkChild);
    /** Returns the tags of the events the session emitted since the last call. */
    const emitted = Queue.clear(channel.events).pipe(
      Effect.map((events) => events.map((event) => event._tag)),
    );
    return { ...controls, result, turns, emitted };
  });

const noDelivery: OnDelivery = () => Effect.void;

/** Records each delivery report: the intervention state when the harness read the message, or `None`. */
const deliveries = () => {
  const reports: Array<Option.Option<InterventionState>> = [];
  const onDelivery: OnDelivery = (delivered) =>
    Effect.sync(() => {
      reports.push(delivered);
    });
  /** Returns each report as `read` with the Hold state at that time, or `unread`. */
  const seen = () =>
    reports.map((report) =>
      Option.match(report, {
        onNone: () => "unread",
        onSome: (state) => (state.held ? "read, held" : "read"),
      }),
    );
  return { onDelivery, seen };
};

describe("session supervision", () => {
  it.effect(
    "reports a message to a working child queued, with no resume, until the harness reads it",
    () =>
      Effect.gen(function* () {
        const session = yield* conversation(child("working"));
        yield* session.emitted;
        const delivery = deliveries();
        const state = yield* session.intervene(
          new OperatorMessage({ message: "Use pnpm, not npm." }),
          delivery.onDelivery,
        );
        assert.deepStrictEqual([state.held, state.paused, state.queued], [true, false, true]);
        assert.notInclude(yield* session.emitted, "SessionResumed");
        assert.deepStrictEqual(delivery.seen(), []);
        yield* session.read((queued) => queued.indexOf("Use pnpm, not npm.") + 1);
        assert.deepStrictEqual(delivery.seen(), ["read, held"]);
        yield* session.finish("Done with pnpm.");
        assert.deepStrictEqual(delivery.seen(), ["read, held"], "a read is reported once");
      }),
  );

  it.effect("reports queued messages read when the turn they joined ends", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("turn-end"));
      const delivery = deliveries();
      yield* session.intervene(new Steer({ message: "Check the lockfile." }), delivery.onDelivery);
      yield* session.finish("Checked.");
      assert.deepStrictEqual(delivery.seen(), ["read"]);
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Checked.");
    }),
  );

  it.effect("reports a queued message unread when the session stops before reading it", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const session = yield* conversation(child("stopped")).pipe(Scope.provide(scope));
      const delivery = deliveries();
      yield* session.intervene(new Steer({ message: "Stop after this." }), delivery.onDelivery);
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(delivery.seen(), ["unread"]);
    }),
  );

  it.effect("reports that an idle held child resumed and read a message at once", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("idle"));
      yield* session.intervene(new OperatorMessage({ message: "Wait for my review." }), noDelivery);
      yield* session.finish("Ready for review.");
      yield* session.emitted;
      const delivery = deliveries();
      const state = yield* session.intervene(
        new OperatorMessage({ message: "Rename the flag." }),
        delivery.onDelivery,
      );
      assert.isFalse(state.queued);
      assert.include(yield* session.emitted, "SessionResumed");
      assert.deepStrictEqual(delivery.seen(), []);
    }),
  );

  it.effect("fails a held child's unresolved blocker only when the operator releases it", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("blocked"));
      yield* session.intervene(
        new OperatorMessage({ message: "Investigate permissions" }),
        noDelivery,
      );
      yield* session.finish("[usine:blocked]\r\nPublishing permission denied.");
      assert.strictEqual(session.result.pollUnsafe(), undefined);
      yield* session.intervene(new Release(), noDelivery);
      const error = yield* Fiber.join(session.result).pipe(Effect.flip);
      assert(error instanceof AgentBlockedError);
      assert.strictEqual(error.message, "Publishing permission denied.");
    }),
  );

  it.effect("allows an operator to resolve a held blocker before completion", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("resolved"));
      yield* session.intervene(
        new OperatorMessage({ message: "Investigate permissions" }),
        noDelivery,
      );
      yield* session.finish("[usine:blocked]\nPermission denied.");
      yield* session.intervene(
        new OperatorMessage({ message: "Permission granted; finish publishing" }),
        noDelivery,
      );
      yield* session.finish("Published. The earlier [usine:blocked] outcome is resolved.");
      yield* session.intervene(new Release(), noDelivery);
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
      assert(error instanceof AgentBlockedError);
      assert.strictEqual(error.message, "Repository permission denied.");
    }),
  );

  it.effect("ends a child that asks the operator a question with the question", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("question"));
      yield* session.finish(
        "[usine:question]\nShould egress use HTTP CONNECT or a SOCKS proxy?\n\nBoth fit the gateway.",
      );
      const error = yield* Fiber.join(session.result).pipe(Effect.flip);
      assert(error instanceof AgentQuestionError);
      assert.strictEqual(
        error.message,
        "Should egress use HTTP CONNECT or a SOCKS proxy?\n\nBoth fit the gateway.",
      );
    }),
  );

  it.effect("fails a blocker marker even when the agent omits its details", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("no-details"));
      yield* session.finish("[usine:blocked]");
      const error = yield* Fiber.join(session.result).pipe(Effect.flip);
      assert(error instanceof AgentBlockedError);
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
        yield* coordinator.intervene(new Interrupt(), noDelivery);
        const boundary = yield* coordinator.awaitUnpaused.pipe(Effect.forkChild);
        yield* first.intervene(new OperatorMessage({ message: "Check this" }), noDelivery);
        yield* second.intervene(new OperatorMessage({ message: "Check that" }), noDelivery);
        yield* first.finish("First result");
        yield* second.finish("Second result");
        assert.strictEqual(first.result.pollUnsafe(), undefined);
        assert.strictEqual(second.result.pollUnsafe(), undefined);
        yield* first.intervene(new Release(), noDelivery);
        assert.strictEqual((yield* Fiber.join(first.result)).message, "First result");
        assert.strictEqual(second.result.pollUnsafe(), undefined);
        assert.strictEqual(boundary.pollUnsafe(), undefined);
        yield* second.intervene(new OperatorMessage({ message: "Revise it" }), noDelivery);
        assert.deepStrictEqual(second.turns.at(-1), { message: "Revise it", activity: "idle" });
        yield* second.finish("Revised result");
        yield* second.intervene(new Release(), noDelivery);
        assert.strictEqual((yield* Fiber.join(second.result)).message, "Revised result");
        const resumed = yield* coordinator.intervene(
          new Steer({ message: "Continue" }),
          noDelivery,
        );
        assert.deepStrictEqual([resumed.held, resumed.paused], [false, false]);
        yield* Fiber.join(boundary);
        yield* coordinator.finish("Coordinator result");
        assert.strictEqual((yield* Fiber.join(coordinator.result)).message, "Coordinator result");
      }),
  );

  it.effect("resumes a paused child with one-shot steering without creating a takeover Hold", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("steered"));
      yield* session.intervene(new Interrupt(), noDelivery);
      yield* session.finish("Paused turn");
      const state = yield* session.intervene(
        new Steer({ message: "Continue with the correction" }),
        noDelivery,
      );
      assert.deepStrictEqual([state.held, state.paused], [false, false]);
      yield* session.finish("Corrected result");
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Corrected result");
    }),
  );
});
