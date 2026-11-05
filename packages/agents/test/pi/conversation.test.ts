import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession, ParentSession } from "@usine/core/agent/session";
import {
  Interrupt,
  type InterventionState,
  OperatorMessage,
  Release,
  Steer,
} from "@usine/core/attempt/channel";
import { Deferred, Effect, Exit, Fiber, Logger, Option, Queue, Scope, Schema } from "effect";
import {
  AgentBlockedError,
  AgentQuestionError,
  AgentResultError,
  type OnDelivery,
  SessionOperationError,
} from "../../src/runtime.ts";
import { sessionChannel } from "../../src/harness/session.ts";
import { sessionConversation } from "../../src/harness/conversation.ts";

const parent = ParentSession.make({
  id: AgentSessionId.make("parent"),
  agent: AgentName.make("developer"),
  brain: BrainSpec.make({
    harness: Harness.make("pi"),
    model: ModelId.make("openai/model"),
    effort: "medium",
  }),
});
const child = (id: string) =>
  ChildSession.make({
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
      held: false,
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

const capturedLogs = () => {
  const entries: Array<Pick<Logger.Options<unknown>, "logLevel" | "message">> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    entries.push({ logLevel, message });
  });
  return { entries, layer: Logger.layer([logger]) };
};

describe("session outcome logs", () => {
  for (const [kind, errorTag] of [
    ["blocked", "AgentBlockedError"],
    ["question", "AgentQuestionError"],
  ] as const) {
    it.effect(`logs a ${kind} report once at Info while preserving its typed outcome`, () => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const session = child(kind);
        const channel = yield* sessionChannel({ sessionId: session.id, label: "Child session" });
        let cleanups = 0;
        channel.onTerminal(() => {
          cleanups += 1;
        });
        yield* channel.finish(session, `[usine:${kind}]\nOperator action required.`);
        const error = yield* Deferred.await(channel.result).pipe(Effect.flip);
        assert.strictEqual(error._tag, errorTag);
        assert.strictEqual(error.message, "Operator action required.");
        const eventError = yield* Queue.take(channel.events).pipe(Effect.flip);
        assert.strictEqual(eventError, error);
        yield* channel.finish(session, "Done.");
        yield* channel.fail(error);
        const terminal = yield* channel.isTerminal;
        assert.isTrue(terminal);
        assert.strictEqual(cleanups, 1);
        assert.deepStrictEqual(logs.entries, [
          {
            logLevel: "Info",
            message: [
              "Child session returned a reserved report",
              { kind, message: error.message, sessionId: session.id },
            ],
          },
        ]);
      }).pipe(Effect.provide(logs.layer));
    });
  }

  for (const error of [
    AgentResultError.make({ sessionId: Option.some(parent.id), message: "Harness failed." }),
    SessionOperationError.make({
      operation: "stream",
      sessionId: Option.some(parent.id),
      message: "Connection lost.",
      cause: new Error("connection closed"),
    }),
  ]) {
    it.effect(`keeps ${error._tag} at Error while preserving its typed outcome`, () => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const channel = yield* sessionChannel({ sessionId: parent.id, label: "Child session" });
        yield* channel.fail(error);
        const resultError = yield* Deferred.await(channel.result).pipe(Effect.flip);
        const eventError = yield* Queue.take(channel.events).pipe(Effect.flip);
        assert.strictEqual(resultError, error);
        assert.strictEqual(eventError, error);
        assert.deepStrictEqual(logs.entries, [
          {
            logLevel: "Error",
            message: [
              "Child session failed",
              { errorTag: error._tag, message: error.message, sessionId: parent.id },
            ],
          },
        ]);
      }).pipe(Effect.provide(logs.layer));
    });
  }
});

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
          OperatorMessage.make({ message: "Use pnpm, not npm." }),
          delivery.onDelivery,
        );
        assert.deepStrictEqual([state.held, state.paused, state.queued], [true, false, true]);
        const currentEmitted = yield* session.emitted;
        assert.notInclude(currentEmitted, "SessionResumed");
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
      yield* session.intervene(Steer.make({ message: "Check the lockfile." }), delivery.onDelivery);
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
      yield* session.intervene(Steer.make({ message: "Stop after this." }), delivery.onDelivery);
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(delivery.seen(), ["unread"]);
    }),
  );

  it.effect("reports that an idle held child resumed and read a message at once", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("idle"));
      yield* session.intervene(
        OperatorMessage.make({ message: "Wait for my review." }),
        noDelivery,
      );
      yield* session.finish("Ready for review.");
      yield* session.emitted;
      const delivery = deliveries();
      const state = yield* session.intervene(
        OperatorMessage.make({ message: "Rename the flag." }),
        delivery.onDelivery,
      );
      assert.isFalse(state.queued);
      const currentEmitted = yield* session.emitted;
      assert.include(currentEmitted, "SessionResumed");
      assert.deepStrictEqual(delivery.seen(), []);
    }),
  );

  it.effect("fails a held child's unresolved blocker only when the operator releases it", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("blocked"));
      yield* session.intervene(
        OperatorMessage.make({ message: "Investigate permissions" }),
        noDelivery,
      );
      yield* session.finish("[usine:blocked]\r\nPublishing permission denied.");
      assert.strictEqual(session.result.pollUnsafe(), undefined);
      yield* session.intervene(Release.make(), noDelivery);
      const error = yield* Fiber.join(session.result).pipe(Effect.flip);
      const matchesError = Schema.is(AgentBlockedError)(error);
      assert(matchesError);
      assert.strictEqual(error.message, "Publishing permission denied.");
    }),
  );

  it.effect("allows an operator to resolve a held blocker before completion", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("resolved"));
      yield* session.intervene(
        OperatorMessage.make({ message: "Investigate permissions" }),
        noDelivery,
      );
      yield* session.finish("[usine:blocked]\nPermission denied.");
      yield* session.intervene(
        OperatorMessage.make({ message: "Permission granted; finish publishing" }),
        noDelivery,
      );
      yield* session.finish("Published. The earlier [usine:blocked] outcome is resolved.");
      yield* session.intervene(Release.make(), noDelivery);
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
      const matchesError = Schema.is(AgentBlockedError)(error);
      assert(matchesError);
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
      const matchesError = Schema.is(AgentQuestionError)(error);
      assert(matchesError);
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
      const matchesError = Schema.is(AgentBlockedError)(error);
      assert(matchesError);
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
        yield* coordinator.intervene(Interrupt.make(), noDelivery);
        const boundary = yield* coordinator.awaitUnpaused.pipe(Effect.forkChild);
        yield* first.intervene(OperatorMessage.make({ message: "Check this" }), noDelivery);
        yield* second.intervene(OperatorMessage.make({ message: "Check that" }), noDelivery);
        yield* first.finish("First result");
        yield* second.finish("Second result");
        assert.strictEqual(first.result.pollUnsafe(), undefined);
        assert.strictEqual(second.result.pollUnsafe(), undefined);
        yield* first.intervene(Release.make(), noDelivery);
        assert.strictEqual((yield* Fiber.join(first.result)).message, "First result");
        assert.strictEqual(second.result.pollUnsafe(), undefined);
        assert.strictEqual(boundary.pollUnsafe(), undefined);
        yield* second.intervene(OperatorMessage.make({ message: "Revise it" }), noDelivery);
        assert.deepStrictEqual(second.turns.at(-1), { message: "Revise it", activity: "idle" });
        yield* second.finish("Revised result");
        yield* second.intervene(Release.make(), noDelivery);
        assert.strictEqual((yield* Fiber.join(second.result)).message, "Revised result");
        const resumed = yield* coordinator.intervene(
          Steer.make({ message: "Continue" }),
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
      yield* session.intervene(Interrupt.make(), noDelivery);
      yield* session.finish("Paused turn");
      const state = yield* session.intervene(
        Steer.make({ message: "Continue with the correction" }),
        noDelivery,
      );
      assert.deepStrictEqual([state.held, state.paused], [false, false]);
      yield* session.finish("Corrected result");
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Corrected result");
    }),
  );
});
