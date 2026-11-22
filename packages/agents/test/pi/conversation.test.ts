import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { Harness, BrainSpec, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  BackgroundWork,
  ChildSession,
  type OperatorMessageId,
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
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Logger,
  Option,
  Predicate,
  Queue,
  Scope,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import {
  AgentBlockedError,
  ChildSessionJournal,
  type OnDelivery,
  RestartState,
} from "../../src/runtime.ts";
import { sessionChannel } from "../../src/harness/session.ts";
import { BACKGROUND_TURN_GRACE, sessionConversation } from "../../src/harness/conversation.ts";
import { type ReadPoint, Receipt } from "../../src/harness/receipts.ts";
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
/** A continuation policy over `restored` that saves nothing; recovery sends a continuation. */
const policyOf = (restored: RestartState): ContinuationPolicy => ({
  restored,
  journal: ChildSessionJournal.noop,
  reopen: (native) => native,
  recover: (_state, _tools, _unread, _emit, send) => send("Continue the task."),
});

/**
 * The signal of the test harness: the operator messages that the session read, and where. Its
 * decoder is all that the test adapter supplies for reads.
 */
interface TestRead {
  readonly ids: ReadonlyArray<OperatorMessageId>;
  readonly at: ReadPoint;
}
const testReceipts = ({ ids, at }: TestRead) => [Receipt.ById({ ids, at, opensTurn: false })];

const conversation = (
  session: ChildSession,
  restored: {
    readonly held?: boolean;
    readonly idle?: Option.Option<string>;
    readonly idleAnsweredOperator?: boolean;
  } = {},
  maxBackgroundWaitMinutes: Option.Option<number> = Option.none(),
) =>
  Effect.gen(function* () {
    const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
    const turns: Array<{ message: string; activity: "idle" | "running" }> = [];
    const controls = yield* sessionConversation({
      session,
      channel,
      policy: policyOf(
        RestartState.make({
          held: restored.held ?? false,
          idle: restored.idle ?? Option.none(),
          idleAnsweredOperator: restored.idleAnsweredOperator ?? false,
        }),
      ),
      decode: testReceipts,
      // A message to a running turn waits for the harness's next boundary.
      send: (message, activity) =>
        Effect.sync(() => {
          turns.push({ message, activity });
          return activity === "idle" ? ("read" as const) : ("queued" as const);
        }),
      pause: Effect.void,
      beforeFinish: Effect.void,
      maxBackgroundWaitMinutes,
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
    /** Signals that the session read `ids` at `at`. */
    const read = (ids: ReadonlyArray<OperatorMessageId>, at: ReadPoint = "now") =>
      controls.observe({ ids, at });
    return {
      ...controls,
      read,
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

const ciWatch = BackgroundWork.make({ id: "ci-watch", kind: "command", description: "Watch CI" });

const capturedLogs = () => {
  const entries: Array<Pick<Logger.Options<unknown>, "logLevel" | "message">> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    entries.push({ logLevel, message });
  });
  return { entries, layer: Logger.layer([logger]) };
};

/** The number of captured log messages that contain `text`. */
const loggedTimes = (logs: ReturnType<typeof capturedLogs>, text: string) =>
  logs.entries.filter(({ message }) => Array.isArray(message) && String(message[0]).includes(text))
    .length;

/** Whether a captured log message contains `text`. */
const logged = (logs: ReturnType<typeof capturedLogs>, text: string) => loggedTimes(logs, text) > 0;

describe("session outcome logs", () => {
  it.effect("logs a blocked report once at Info while preserving its typed outcome", () => {
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const session = child("blocked");
      const channel = yield* sessionChannel({ sessionId: session.id, label: "Child session" });
      let cleanups = 0;
      channel.onTerminal(() => {
        cleanups += 1;
      });
      yield* channel.finish(session, "[usine:blocked]\nOperator action required.");
      const error = yield* Deferred.await(channel.result).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentBlockedError");
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
            { kind: "blocked", message: error.message, sessionId: session.id },
          ],
        },
      ]);
    }).pipe(Effect.provide(logs.layer));
  });
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
    "keeps an answer whose wait limit passes during an operator message for a Release",
    () => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const session = child("overdue-takeover");
        const channel = yield* sessionChannel({
          sessionId: session.id,
          label: "Conversation test",
        });
        const sending = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const controls = yield* sessionConversation({
          session,
          channel,
          policy: policyOf(RestartState.make({})),
          decode: testReceipts,
          send: () =>
            Deferred.succeed(sending, undefined).pipe(
              Effect.andThen(Deferred.await(delivered)),
              Effect.as("read" as const),
            ),
          pause: Effect.void,
          beforeFinish: Effect.void,
          maxBackgroundWaitMinutes: Option.some(1),
        });
        yield* controls.reportBackground(Option.some([ciWatch]));
        yield* controls.finish("Waiting for CI");
        const takeover = yield* controls
          .intervene(OperatorMessage.make({ message: "Wait for my review." }), noDelivery)
          .pipe(Effect.forkChild);
        yield* Deferred.await(sending);
        yield* TestClock.adjust("1 minute");
        const returnedDuringSend = yield* Deferred.isDone(channel.result);
        assert.isFalse(returnedDuringSend);

        yield* Deferred.succeed(delivered, undefined);
        assert.isTrue((yield* Fiber.join(takeover)).held);
        while (!logged(logs, "the operator's Hold or pause keeps its answer"))
          yield* Effect.yieldNow;
        const terminal = yield* channel.isTerminal;
        const idle = yield* controls.isIdle;
        const events = yield* Queue.clear(channel.events);
        assert.isFalse(terminal);
        assert.isFalse(idle);
        assert.deepStrictEqual(
          events.map((event) => event._tag),
          ["BackgroundWorkUpdated", "OperatorMessageRead"],
        );

        yield* controls.intervene(Release.make(), noDelivery);
        assert.strictEqual((yield* Deferred.await(channel.result)).message, "Waiting for CI");
        const finished = yield* Queue.take(channel.events);
        assert(finished._tag === "SessionFinished");
        assert.isTrue(finished.backgroundWaitLimitPassed);
      }).pipe(Effect.provide(logs.layer));
    },
  );

  it.effect("returns the latest answer at a Release that a starting turn waits for", () => {
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const session = child("overdue-release");
      const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
      const finishing = yield* Deferred.make<void>();
      const cleanedUp = yield* Deferred.make<void>();
      const controls = yield* sessionConversation({
        session,
        channel,
        policy: policyOf(RestartState.make({ held: true, idle: Option.some("CI passed") })),
        decode: testReceipts,
        send: () => Effect.succeed("read"),
        pause: Effect.void,
        beforeFinish: Deferred.succeed(finishing, undefined).pipe(
          Effect.andThen(Deferred.await(cleanedUp)),
        ),
        maxBackgroundWaitMinutes: Option.some(1),
      });
      yield* controls.reportBackground(Option.some([ciWatch]));
      yield* controls.finish("Waiting for CI");
      yield* TestClock.adjust("1 minute");
      while (!logged(logs, "the operator's Hold or pause keeps its answer")) yield* Effect.yieldNow;
      const release = yield* controls.intervene(Release.make(), noDelivery).pipe(Effect.forkChild);
      yield* Deferred.await(finishing);
      const turn = yield* controls.turnStarted.pipe(Effect.forkChild({ startImmediately: true }));
      assert.strictEqual(turn.pollUnsafe(), undefined);
      const returnedDuringCleanup = yield* Deferred.isDone(channel.result);
      assert.isFalse(returnedDuringCleanup);

      yield* Deferred.succeed(cleanedUp, undefined);
      assert.isFalse((yield* Fiber.join(release)).held);
      yield* Fiber.join(turn);
      assert.strictEqual(
        (yield* Deferred.await(channel.result)).message,
        "Waiting for CI",
        "the answer of the later turn replaces the restored idle report",
      );
      const finished = (yield* Queue.clear(channel.events)).find(
        (event) => event._tag === "SessionFinished",
      );
      assert(finished?._tag === "SessionFinished");
      assert.isTrue(finished.backgroundWaitLimitPassed);
      assert.isFalse(
        logged(logs, "The session started a turn; dropping"),
        "the Release returned the kept answer before the turn started",
      );
    }).pipe(Effect.provide(logs.layer));
  });

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

  it.effect("does not resend native queued guidance when an idle child gets another steer", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("queued-idle"));
      const first = Steer.make({ message: "A" });
      const second = Steer.make({ message: "B" });
      const delivery = deliveries();
      yield* session.intervene(first, delivery.onDelivery);
      yield* session.intervene(Interrupt.make(), noDelivery);
      yield* session.finish("Paused turn");
      yield* session.intervene(second, delivery.onDelivery);
      assert.deepStrictEqual(
        session.turns.map(({ message }) => message),
        ["A", "B"],
      );
      assert.deepStrictEqual(
        (yield* session.unread).map(({ id }) => id),
        [first.id],
      );
      yield* session.read([first.id, second.id]);
      assert.deepStrictEqual(delivery.seen(), ["read"]);
    }),
  );

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
      name: "doesn't mark an answer to a steer that a turn folded in before a later tool call",
      before: [],
      after: ["call-1", "call-2"],
      answered: false,
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
      yield* session.recover([], () => Effect.succeed("queued" as const));
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
});

describe("background work", () => {
  const nothingRuns = Option.some<ReadonlyArray<BackgroundWork>>([]);
  const lint = BackgroundWork.make({ id: "lint", kind: "command", description: "Run lint" });
  const graceStarted = "it returns its answer unless a turn starts within the grace period";
  /** Just short of the grace period after the background work ends. */
  const almostGrace = Duration.subtract(BACKGROUND_TURN_GRACE, Duration.seconds(1));
  /** Returns whether each `SessionFinished` in `events` reports a passed wait limit. */
  const limitsPassed = (events: ReadonlyArray<{ readonly _tag: string }>) =>
    events.flatMap((event) =>
      event._tag === "SessionFinished" && Predicate.hasProperty(event, "backgroundWaitLimitPassed")
        ? [event.backgroundWaitLimitPassed]
        : [],
    );

  it.effect.each([
    { limit: Option.none<number>(), label: "no limit", returnsAfter: BACKGROUND_TURN_GRACE },
    {
      limit: Option.some(2),
      label: "a two-minute limit",
      returnsAfter: Duration.min(BACKGROUND_TURN_GRACE, Duration.minutes(2)),
    },
  ])(
    "returns the answer once its background work ends and no turn starts in time ($label)",
    ({ limit, returnsAfter }) =>
      Effect.gen(function* () {
        const session = yield* conversation(child("work-ended"), {}, limit);
        yield* session.reportBackground(Option.some([ciWatch]));
        yield* session.finish("Waiting for CI");
        yield* session.reportBackground(nothingRuns);
        yield* TestClock.adjust(Duration.subtract(returnsAfter, Duration.seconds(1)));
        assert.isUndefined(session.result.pollUnsafe(), "the session waits for a turn");
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Fiber.join(session.result)).message, "Waiting for CI");
        const events = yield* session.events;
        assert.deepStrictEqual(
          limitsPassed(events),
          [false],
          "the work ended before the limit, so no limit passed",
        );
      }),
  );

  it.effect("keeps waiting for a turn that starts within the grace period", () => {
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const session = yield* conversation(child("notification-turn"));
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Waiting for CI");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust(almostGrace);
      yield* session.turnStarted;
      assert.isTrue(
        logged(logs, "Session cancelled the return of its answer after its background work ended"),
        "the turn cancels the return",
      );
      yield* TestClock.adjust("10 hours");
      assert.isUndefined(session.result.pollUnsafe(), "the turn keeps the session open");
      yield* session.finish("CI passed");
      assert.strictEqual((yield* Fiber.join(session.result)).message, "CI passed");
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("waits for the work that a turn within the grace period starts", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("notification-turn-work"));
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Waiting for CI");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust("1 minute");
      yield* session.turnStarted;
      yield* session.reportBackground(Option.some([lint]));
      yield* session.finish("Waiting for lint");
      yield* TestClock.adjust("10 hours");
      assert.isUndefined(session.result.pollUnsafe(), "the turn's answer waits for its own work");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust(almostGrace);
      assert.isUndefined(session.result.pollUnsafe(), "the turn's work has its own grace period");
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Waiting for lint");
    }),
  );

  it.effect("drops the earlier answer when a turn starts within the grace period", () => {
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const session = yield* conversation(child("notification-turn-answer"));
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Waiting for CI");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust("1 minute");
      yield* session.turnStarted;
      yield* session.reportBackground(Option.some([lint]));
      yield* session.reportBackground(nothingRuns);
      assert.strictEqual(
        loggedTimes(logs, graceStarted),
        1,
        "work that ends before the turn answers starts no grace period",
      );
      yield* TestClock.adjust("10 hours");
      assert.isUndefined(
        session.result.pollUnsafe(),
        "the turn that started keeps the session open",
      );
      yield* session.finish("CI passed");
      assert.strictEqual((yield* Fiber.join(session.result)).message, "CI passed");
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("keeps waiting when its background work runs again within the grace period", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("work-again"));
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Waiting for CI");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust(almostGrace);
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* TestClock.adjust("10 hours");
      assert.isUndefined(session.result.pollUnsafe(), "the work that runs again keeps the wait");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust(almostGrace);
      assert.isUndefined(session.result.pollUnsafe(), "each end of the work has a grace period");
      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Waiting for CI");
    }),
  );

  it.effect.each(["Hold", "pause"] as const)(
    "keeps the answer, without an idle report, when its background work ends under a %s",
    (supervision) => {
      const logs = capturedLogs();
      return Effect.gen(function* () {
        const session = yield* conversation(child(`work-ended-${supervision}`), {
          held: supervision === "Hold",
        });
        if (supervision === "pause") yield* session.intervene(Interrupt.make(), noDelivery);
        yield* session.reportBackground(Option.some([ciWatch]));
        yield* session.finish("Waiting for CI");
        yield* session.reportBackground(nothingRuns);
        yield* TestClock.adjust(BACKGROUND_TURN_GRACE);
        while (!logged(logs, "the operator's Hold or pause keeps its answer until a Release"))
          yield* Effect.yieldNow;
        assert.isUndefined(session.result.pollUnsafe());
        const emitted = yield* session.emitted;
        assert.notInclude(emitted, "SessionIdle");
        // A repeated `initialize` sends the empty snapshot again.
        yield* session.reportBackground(nothingRuns);
        assert.strictEqual(
          loggedTimes(logs, graceStarted),
          1,
          "a kept answer starts no grace period",
        );
        yield* session.intervene(Release.make(), noDelivery);
        if (supervision === "pause") {
          yield* TestClock.adjust("10 hours");
          assert.isUndefined(session.result.pollUnsafe(), "a Release doesn't end a paused session");
          return;
        }
        assert.strictEqual((yield* Fiber.join(session.result)).message, "Waiting for CI");
        const events = yield* session.events;
        assert.deepStrictEqual(limitsPassed(events), [false]);
      }).pipe(Effect.provide(logs.layer));
    },
  );

  it.effect("cancels the grace period when the harness process restarts", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("restarted"));
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Waiting for CI");
      yield* session.reportBackground(nothingRuns);
      yield* session.processRestarted;
      yield* TestClock.adjust("10 hours");
      assert.isUndefined(session.result.pollUnsafe(), "the recovery decides what the session does");
    }),
  );

  it.effect("keeps the grace period of the first snapshot that lists no work", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("work-ended-twice"));
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Waiting for CI");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust("1 minute");
      // A repeated `initialize` sends the empty snapshot again.
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust(Duration.subtract(almostGrace, Duration.minutes(1)));
      assert.isUndefined(session.result.pollUnsafe(), "the session waits for a turn");
      yield* TestClock.adjust("1 second");
      assert.isDefined(
        session.result.pollUnsafe(),
        "the grace period runs from the first snapshot that lists no work",
      );
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Waiting for CI");
    }),
  );

  it.effect("stops the grace period of a waiting answer that a later answer replaces", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("grace-replaced"), { held: true });
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Waiting for CI");
      yield* session.reportBackground(nothingRuns);
      // The idle report replaces the answer that waits, so the grace period of its wait stops.
      yield* session.finish("CI passed");
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Waiting for the rerun");
      yield* TestClock.adjust(BACKGROUND_TURN_GRACE);
      yield* session.intervene(Release.make(), noDelivery);
      yield* TestClock.adjust("10 hours");
      assert.isUndefined(
        session.result.pollUnsafe(),
        "the latest answer waits for the work that still runs",
      );
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust(BACKGROUND_TURN_GRACE);
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Waiting for the rerun");
      const events = yield* session.events;
      assert.deepStrictEqual(limitsPassed(events), [false]);
    }),
  );

  it.effect("resumes a session that last reported idle when its later answer waits for work", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("idle-then-waiting"), {
        held: true,
        idle: Option.some("Waiting for review"),
      });
      // The harness starts a turn of its own, whose answer waits for its work.
      yield* session.turnStarted;
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Watching CI");
      const reported = yield* session.emitted;
      assert.deepStrictEqual(reported, ["SessionIdle", "BackgroundWorkUpdated"]);
      yield* session.intervene(OperatorMessage.make({ message: "Is CI green?" }), noDelivery);
      const resumed = yield* session.emitted;
      assert.deepStrictEqual(resumed, ["SessionResumed"], "the session last reported idle");
      yield* session.intervene(OperatorMessage.make({ message: "And the lint?" }), noDelivery);
      const again = yield* session.emitted;
      assert.deepStrictEqual(again, [], "the session already resumed");
    }),
  );

  /**
   * Starts a conversation whose harness takes a steer only after `unlock`. `lock` sends a steer,
   * which holds the conversation's lock until then.
   */
  const lockedBySteer = (id: string) =>
    Effect.gen(function* () {
      const session = child(id);
      const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
      const sending = yield* Deferred.make<void>();
      const sent = yield* Deferred.make<void>();
      const controls = yield* sessionConversation({
        session,
        channel,
        policy: policyOf(RestartState.make({})),
        decode: testReceipts,
        send: () =>
          Deferred.succeed(sending, undefined).pipe(
            Effect.andThen(Deferred.await(sent)),
            Effect.as("read" as const),
          ),
        pause: Effect.void,
        beforeFinish: Effect.void,
        maxBackgroundWaitMinutes: Option.none(),
      });
      const lock = controls
        .intervene(Steer.make({ message: "Check the logs too." }), noDelivery)
        .pipe(
          Effect.forkChild,
          Effect.tap(() => Deferred.await(sending)),
        );
      return { channel, controls, lock, unlock: Deferred.succeed(sent, undefined) };
    });

  it.effect("applies a snapshot after an answer that waits for the lock before it", () =>
    Effect.gen(function* () {
      const { channel, controls, lock, unlock } = yield* lockedBySteer("snapshot-order");
      const steer = yield* lock;
      const answer = yield* controls
        .finish("Done")
        .pipe(Effect.forkChild({ startImmediately: true }));
      const snapshot = yield* controls
        .reportBackground(Option.some([ciWatch]))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* unlock;
      yield* Fiber.join(steer);
      yield* Fiber.join(answer);
      yield* Fiber.join(snapshot);
      assert.strictEqual(
        (yield* Deferred.await(channel.result)).message,
        "Done",
        "the answer came before the work, so it doesn't wait for it",
      );
    }),
  );

  it.effect("applies a process restart after an answer that waits for the lock before it", () =>
    Effect.gen(function* () {
      const { channel, controls, lock, unlock } = yield* lockedBySteer("restart-order");
      yield* controls.reportBackground(Option.some([ciWatch]));
      const steer = yield* lock;
      const answer = yield* controls
        .finish("Done")
        .pipe(Effect.forkChild({ startImmediately: true }));
      const restart = yield* controls.processRestarted.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* unlock;
      yield* Fiber.join(steer);
      yield* Fiber.join(answer);
      yield* Fiber.join(restart);
      yield* TestClock.adjust("10 hours");
      const returned = yield* Deferred.isDone(channel.result);
      assert.isFalse(
        returned,
        "the answer waits for the listed work, and the restart leaves it to the recovery",
      );
    }),
  );
});

describe("own inputs", () => {
  /**
   * Starts a conversation whose harness holds the own inputs in `held` for its next turn, as Codex
   * holds a continuation sent while a turn is interrupting. `received` runs at each save.
   */
  const ownInputs = (
    id: string,
    held: Array<string> = [],
    received: ChildSessionJournal["Service"]["received"] = ChildSessionJournal.noop.received,
  ) =>
    Effect.gen(function* () {
      const session = child(id);
      const channel = yield* sessionChannel({ sessionId: session.id, label: "Conversation test" });
      const policy = policyOf(RestartState.make({}));
      const controls = yield* sessionConversation({
        session,
        channel,
        policy: {
          ...policy,
          journal: ChildSessionJournal.of({ ...ChildSessionJournal.noop, received }),
        },
        decode: (receipt: Receipt) => [receipt],
        send: () => Effect.succeed("queued" as const),
        pause: Effect.void,
        beforeFinish: Effect.void,
        maxBackgroundWaitMinutes: Option.none(),
        heldOwnInputs: Effect.sync(() => held.length),
      });
      /** Signals that the harness recorded an input with `text` as native item `item`. */
      const record = (text: string, item: string) =>
        controls.observe(
          Receipt.ByText({ text, at: "now", item: Option.some({ id: item, turn: "turn-1" }) }),
        );
      return { ...controls, record };
    });
  /** Blocks each save until `saved` completes; `saving` completes when the first one starts. */
  const blockedSaves = Effect.gen(function* () {
    const saving = yield* Deferred.make<void>();
    const saved = yield* Deferred.make<void>();
    return {
      saving,
      saved,
      received: () =>
        Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(saved))),
    };
  });

  it.effect("drops the own inputs at a turn end that waits for the lock during a save", () =>
    Effect.gen(function* () {
      const { saving, saved, received } = yield* blockedSaves;
      const session = yield* ownInputs("turn-end-order", [], received);
      yield* session.sendOwn("Do the task", () => Effect.void);
      const other = yield* session.record("Look around first.", "item-1").pipe(Effect.forkChild);
      yield* Deferred.await(saving);
      const turnEnd = yield* session.turnEnded.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(saved, undefined);
      yield* Fiber.join(other);
      yield* Fiber.join(turnEnd);
      yield* session.intervene(OperatorMessage.make({ message: "Do the task" }), noDelivery);
      const { read } = yield* session.record("Do the task", "item-2");
      assert.lengthOf(
        read,
        1,
        "the turn end dropped the own input, so the record reads the message",
      );
    }),
  );

  it.effect("keeps an own input that the harness holds for its next turn past a turn end", () =>
    Effect.gen(function* () {
      const held: Array<string> = [];
      const session = yield* ownInputs("held-continuation", held);
      // A turn is interrupting, so the harness holds the recovery's continuation for the next turn.
      yield* session.recover([], (message) =>
        Effect.sync(() => {
          held.push(message);
          return "queued" as const;
        }),
      );
      yield* session.turnEnded;
      // The next turn starts with the continuation.
      held.splice(0);
      yield* session.intervene(OperatorMessage.make({ message: "Continue the task." }), noDelivery);
      const { read } = yield* session.record("Continue the task.", "continuation");
      assert.deepStrictEqual(read, [], "the record is the continuation's");
      const unread = yield* session.unread;
      assert.lengthOf(unread, 1);
    }),
  );

  it.effect("applies a turn end that arrives during an own input's send after the send", () =>
    Effect.gen(function* () {
      const held: Array<string> = [];
      const session = yield* ownInputs("turn-end-during-send", held);
      const sending = yield* Deferred.make<void>();
      const sent = yield* Deferred.make<void>();
      const send = yield* session
        .sendOwn("Continue the task.", (message) =>
          Deferred.succeed(sending, undefined).pipe(
            Effect.andThen(Deferred.await(sent)),
            Effect.andThen(Effect.sync(() => held.push(message))),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(sending);
      const turnEnd = yield* session.turnEnded.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(sent, undefined);
      yield* Fiber.join(send);
      yield* Fiber.join(turnEnd);
      held.splice(0);
      yield* session.intervene(OperatorMessage.make({ message: "Continue the task." }), noDelivery);
      const { read } = yield* session.record("Continue the task.", "continuation");
      assert.deepStrictEqual(
        read,
        [],
        "the turn end counted the continuation that the harness holds for its next turn",
      );
    }),
  );

  it.effect("keeps an own input that is sent while a receipt saves", () =>
    Effect.gen(function* () {
      const { saving, saved, received } = yield* blockedSaves;
      const session = yield* ownInputs("send-during-save", [], received);
      const other = yield* session.record("Look around first.", "item-1").pipe(Effect.forkChild);
      yield* Deferred.await(saving);
      const send = yield* session
        .sendOwn("Do the task", () => Effect.void)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(saved, undefined);
      yield* Fiber.join(other);
      yield* Fiber.join(send);
      yield* session.intervene(OperatorMessage.make({ message: "Do the task" }), noDelivery);
      const { read } = yield* session.record("Do the task", "item-2");
      assert.deepStrictEqual(
        read,
        [],
        "the save didn't write back an inbox without the task, so the record is the task's",
      );
    }),
  );
});
