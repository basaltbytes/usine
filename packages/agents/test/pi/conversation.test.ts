import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  ParentSession,
  ToolFinished,
  ToolStarted,
} from "@usine/core/agent/session";
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
  RestartState,
  SessionOperationError,
} from "../../src/runtime.ts";
import { sessionChannel } from "../../src/harness/session.ts";
import { sessionConversation } from "../../src/harness/conversation.ts";
import type { ContinuationPolicy } from "../../src/harness/continuation.ts";

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
const conversation = (
  session: ChildSession,
  restored: {
    readonly held?: boolean;
    readonly idle?: Option.Option<string>;
    readonly idleAnsweredOperator?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
    const turns: Array<{ message: string; activity: "idle" | "running" }> = [];
    const controls = yield* sessionConversation({
      session,
      channel,
      held: restored.held ?? false,
      paused: false,
      idle: restored.idle ?? Option.none(),
      idleAnsweredOperator: restored.idleAnsweredOperator ?? false,
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
    /** Returns the events the session emitted since the last call. */
    const events = Queue.clear(channel.events);
    /** Emits a started tool call, as the harness does when the session runs a tool. */
    const runTool = (callId: string) =>
      channel.emit(ToolStarted.make({ session, callId, tool: "bash", input: null }));
    /** Emits a tool call's result, as the harness does when the tool returns. */
    const finishTool = (callId: string) =>
      channel.emit(
        ToolFinished.make({ session, callId, tool: "bash", output: "ok", isError: false }),
      );
    /** Runs a tool call to its result. */
    const runToolRound = (callId: string) =>
      runTool(callId).pipe(Effect.andThen(finishTool(callId)));
    /** Queues a started tool call from a vendor callback, as Pi does. */
    const runToolUnsafe = (callId: string) =>
      Effect.sync(() =>
        channel.emitUnsafe(ToolStarted.make({ session, callId, tool: "bash", input: null })),
      );
    return {
      ...controls,
      result,
      turns,
      emitted,
      events,
      runTool,
      finishTool,
      runToolRound,
      runToolUnsafe,
      toolCalls: channel.toolCalls,
    };
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
  it.effect("keeps an overdue answer under the Hold of an in-flight operator message", () =>
    Effect.gen(function* () {
      const session = child("overdue-takeover");
      const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
      const sending = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const controls = yield* sessionConversation({
        session,
        channel,
        held: false,
        paused: false,
        idle: Option.none(),
        idleAnsweredOperator: false,
        send: () =>
          Deferred.succeed(sending, undefined).pipe(
            Effect.andThen(Deferred.await(delivered)),
            Effect.as("read" as const),
          ),
        pause: Effect.void,
        beforeFinish: Effect.void,
      });
      const takeover = yield* controls
        .intervene(OperatorMessage.make({ message: "Wait for my review." }), noDelivery)
        .pipe(Effect.forkChild);
      yield* Deferred.await(sending);
      const overdue = yield* controls
        .finishOverdue("Waiting for CI", Effect.void)
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.strictEqual(overdue.pollUnsafe(), undefined);
      const returnedDuringSend = yield* Deferred.isDone(channel.result);
      assert.isFalse(returnedDuringSend);

      yield* Deferred.succeed(delivered, undefined);
      assert.isTrue((yield* Fiber.join(takeover)).held);
      const finishedOverdue = yield* Fiber.join(overdue);
      const terminal = yield* channel.isTerminal;
      const idle = yield* controls.isIdle;
      const events = yield* Queue.clear(channel.events);
      assert.isFalse(finishedOverdue);
      assert.isFalse(terminal);
      assert.isFalse(idle);
      assert.deepStrictEqual(events, []);

      yield* controls.intervene(Release.make(), noDelivery);
      assert.strictEqual((yield* Deferred.await(channel.result)).message, "Waiting for CI");
    }),
  );

  it.effect("waits for a Release to finish before dropping a kept answer", () =>
    Effect.gen(function* () {
      const session = child("overdue-release");
      const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
      const finishing = yield* Deferred.make<void>();
      const cleanedUp = yield* Deferred.make<void>();
      const controls = yield* sessionConversation({
        session,
        channel,
        held: true,
        paused: false,
        idle: Option.some("CI passed"),
        idleAnsweredOperator: false,
        send: () => Effect.succeed("read"),
        pause: Effect.void,
        beforeFinish: Deferred.succeed(finishing, undefined).pipe(
          Effect.andThen(Deferred.await(cleanedUp)),
        ),
      });
      const finishedOverdue = yield* controls.finishOverdue("Waiting for CI", Effect.void);
      assert.isFalse(finishedOverdue);
      const release = yield* controls.intervene(Release.make(), noDelivery).pipe(Effect.forkChild);
      yield* Deferred.await(finishing);
      const drop = yield* controls.dropOverdue.pipe(Effect.forkChild({ startImmediately: true }));
      assert.strictEqual(drop.pollUnsafe(), undefined);
      const returnedDuringCleanup = yield* Deferred.isDone(channel.result);
      assert.isFalse(returnedDuringCleanup);

      yield* Deferred.succeed(cleanedUp, undefined);
      assert.isFalse((yield* Fiber.join(release)).held);
      const dropped = yield* Fiber.join(drop);
      assert.isTrue(dropped);
      assert.strictEqual((yield* Deferred.await(channel.result)).message, "CI passed");
      const droppedAgain = yield* controls.dropOverdue;
      assert.isFalse(droppedAgain);
    }),
  );

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
        const unread = yield* session.unread;
        yield* session.read(unread.map(({ id }) => id));
        assert.deepStrictEqual(delivery.seen(), ["read, held"]);
        yield* session.finish("Done with pnpm.");
        assert.deepStrictEqual(delivery.seen(), ["read, held"], "a read is reported once");
      }),
  );

  for (const stopped of ["paused", "idle"] as const) {
    it.effect(
      `does not resend native queued guidance when a ${stopped} child gets another steer`,
      () =>
        Effect.gen(function* () {
          const session = yield* conversation(child(`queued-${stopped}`));
          const first = Steer.make({ message: "A" });
          const second = Steer.make({ message: "B" });
          const delivery = deliveries();
          yield* session.intervene(first, delivery.onDelivery);
          yield* session.intervene(Interrupt.make(), noDelivery);
          if (stopped === "idle") yield* session.finish("Paused turn");
          yield* session.intervene(second, delivery.onDelivery);
          assert.deepStrictEqual(
            session.turns.map(({ message }) => message),
            ["A", "B"],
          );
          assert.deepStrictEqual(
            (yield* session.unread).map(({ id }) => id),
            stopped === "idle" ? [first.id] : [first.id, second.id],
          );
          yield* session.read([first.id, second.id]);
          assert.deepStrictEqual(delivery.seen(), stopped === "idle" ? ["read"] : ["read", "read"]);
        }),
    );
  }

  it.effect("keeps messages unread until the harness acknowledges their IDs", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("turn-end"));
      const delivery = deliveries();
      yield* session.intervene(Steer.make({ message: "Check the lockfile." }), delivery.onDelivery);
      yield* session.finish("Checked.");
      assert.deepStrictEqual(delivery.seen(), []);
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
      yield* session.read((yield* session.unread).map(({ id }) => id));
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

  it.effect("finishes a child whose answer quotes a marker in a code block", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("quoted"));
      const answer =
        "The review passed. The parser reports:\n```text\n[usine:blocked]\nPermission denied.\n```";
      yield* session.finish(answer);
      assert.strictEqual((yield* Fiber.join(session.result)).message, answer);
    }),
  );

  it.effect("fails a child whose blocker header follows narration", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("narrated"));
      yield* session.finish("The delegation was interrupted.[usine:blocked]\nNo review posted.");
      const error = yield* Fiber.join(session.result).pipe(Effect.flip);
      const matchesError = Schema.is(AgentBlockedError)(error);
      assert(matchesError);
      assert.strictEqual(error.message, "No review posted.");
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
        yield* second.read((yield* second.unread).map(({ id }) => id));
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

describe("answers to the operator", () => {
  /** Returns a held child that finished its task turn and waits idle after one tool call. */
  const heldAfterWork = (id: string) =>
    Effect.gen(function* () {
      const session = yield* conversation(child(id));
      yield* session.intervene(OperatorMessage.make({ message: "Wait for me." }), noDelivery);
      yield* session.read((yield* session.unread).map(({ id }) => id));
      yield* session.runTool("call-1");
      yield* session.finish("Opened the pull request.");
      return session;
    });

  it.effect("marks a final answer that replies to the operator's message", () =>
    Effect.gen(function* () {
      const session = yield* heldAfterWork("answered");
      yield* session.intervene(
        OperatorMessage.make({ message: "Why did you skip the tests?" }),
        noDelivery,
      );
      yield* session.finish("The tests need a database.");
      yield* session.intervene(Release.make(), noDelivery);
      const result = yield* Fiber.join(session.result);
      assert.strictEqual(result.message, "The tests need a database.");
      assert.isTrue(result.answeredOperator);
    }),
  );

  it.effect("doesn't mark an answer when a tool call followed the operator's input", () =>
    Effect.gen(function* () {
      const session = yield* heldAfterWork("worked-after");
      yield* session.intervene(Steer.make({ message: "Run the tests too." }), noDelivery);
      yield* session.runTool("call-2");
      yield* session.finish("The tests pass.");
      yield* session.intervene(Release.make(), noDelivery);
      assert.isFalse((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("marks the answer to a queued message that the session read after its last tool", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("queued-answer"));
      yield* session.runTool("call-1");
      yield* session.intervene(Steer.make({ message: "What changed?" }), noDelivery);
      yield* session.read((yield* session.unread).map(({ id }) => id));
      yield* session.finish("Only the lockfile changed.");
      assert.isTrue((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("doesn't mark an answer when a vendor callback queued a later tool call", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("vendor-tool"));
      yield* session.intervene(Steer.make({ message: "What changed?" }), noDelivery);
      yield* session.read((yield* session.unread).map(({ id }) => id));
      yield* session.runToolUnsafe("call-1");
      yield* session.finish("Only the lockfile changed.");
      assert.isFalse((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("counts a read at the tool-call count that the harness captured", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("captured-read"));
      yield* session.intervene(Steer.make({ message: "What changed?" }), noDelivery);
      const captured = yield* session.toolCalls;
      // A tool call that the harness started before the forked read ran.
      yield* session.runTool("call-1");
      yield* session.read(
        (yield* session.unread).map(({ id }) => id),
        captured,
      );
      yield* session.finish("Only the lockfile changed.");
      assert.isFalse((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("keeps the later of two reads when the harness reports an earlier one last", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("later-read"));
      yield* session.intervene(Steer.make({ message: "Check the lockfile." }), noDelivery);
      yield* session.intervene(Steer.make({ message: "Check the tests." }), noDelivery);
      const [first, second] = yield* session.unread;
      assert(first !== undefined && second !== undefined);
      yield* session.runTool("call-1");
      const captured = yield* session.toolCalls;
      yield* session.runTool("call-2");
      yield* session.read([first.id]);
      // A forked read that the harness captured before the second tool call runs last.
      yield* session.read([second.id], captured);
      yield* session.finish("Both are fine.");
      assert.isTrue((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  // A turn's result acknowledges input that the turn folded in at the first tool result after the
  // input was queued, or at its end.
  for (const { name, before, after, answered } of [
    {
      name: "marks an answer to a steer that a turn folded in at the next tool result",
      before: [],
      after: ["call-1"],
      answered: true,
    },
    {
      name: "marks an answer to a steer queued after an earlier tool round, folded in at the next",
      before: ["call-1"],
      after: ["call-2"],
      answered: true,
    },
    {
      name: "doesn't mark an answer to a steer that a turn folded in before a later tool call",
      before: [],
      after: ["call-1", "call-2"],
      answered: false,
    },
    {
      name: "marks an answer to a steer that a turn with no later tool round read at its end",
      before: ["call-1"],
      after: [],
      answered: true,
    },
  ])
    it.effect(name, () =>
      Effect.gen(function* () {
        const session = yield* conversation(child("turn-read"));
        for (const callId of before) yield* session.runToolRound(callId);
        yield* session.intervene(Steer.make({ message: "Run the tests too." }), noDelivery);
        for (const callId of after) yield* session.runToolRound(callId);
        yield* session.read(
          (yield* session.unread).map(({ id }) => id),
          "turn",
        );
        yield* session.finish("The tests pass.");
        assert.strictEqual((yield* Fiber.join(session.result)).answeredOperator, answered);
      }),
    );

  it.effect("reads several messages of one turn at the latest point that it folded one in", () =>
    Effect.gen(function* () {
      for (const { later, answered } of [
        { later: false, answered: true },
        { later: true, answered: false },
      ]) {
        const session = yield* conversation(child(`turn-reads-${String(later)}`));
        yield* session.intervene(Steer.make({ message: "Check the lockfile." }), noDelivery);
        // The turn folds in the first steer here, and the second one at the next tool result.
        yield* session.runToolRound("call-1");
        yield* session.intervene(Steer.make({ message: "Check the tests." }), noDelivery);
        yield* session.runToolRound("call-2");
        if (later) yield* session.runToolRound("call-3");
        yield* session.read(
          (yield* session.unread).map(({ id }) => id),
          "turn",
        );
        yield* session.finish("Both are fine.");
        assert.strictEqual((yield* Fiber.join(session.result)).answeredOperator, answered);
      }
    }),
  );

  it.effect("doesn't mark an answer after the harness's own continuation input", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("continued"));
      yield* session.intervene(Steer.make({ message: "What changed?" }), noDelivery);
      yield* session.read((yield* session.unread).map(({ id }) => id));
      const policy: ContinuationPolicy = {
        restored: RestartState.make({}),
        reopen: (native) => native,
        recover: (_state, _tools, _unread, _emit, send) => send("Continue the task."),
      };
      yield* session.recover(policy, [], () => Effect.succeed("queued" as const));
      yield* session.finish("Done.");
      assert.isFalse((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );

  it.effect("keeps the answer to the operator of an idle report restored under a Hold", () =>
    Effect.gen(function* () {
      const answered = yield* heldAfterWork("idle-answer");
      yield* answered.intervene(OperatorMessage.make({ message: "Why?" }), noDelivery);
      yield* answered.events;
      yield* answered.finish("The tests need a database.");
      const [idle] = yield* answered.events;
      assert(idle?._tag === "SessionIdle");
      assert.isTrue(idle.answeredOperator);

      // A restart restores the stored idle report and whether it answered the operator.
      const restored = yield* conversation(child("idle-answer-restored"), {
        held: true,
        idle: idle.message,
        idleAnsweredOperator: idle.answeredOperator,
      });
      yield* restored.intervene(Release.make(), noDelivery);
      const result = yield* Fiber.join(restored.result);
      assert.strictEqual(result.message, "The tests need a database.");
      assert.isTrue(result.answeredOperator);
    }),
  );

  it.effect("doesn't mark a report that follows the session's own work", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("own-work"));
      yield* session.runTool("call-1");
      yield* session.finish("Opened the pull request.");
      assert.isFalse((yield* Fiber.join(session.result)).answeredOperator);
    }),
  );
});
