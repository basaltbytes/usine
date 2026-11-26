import { assert, describe, it } from "@effect/vitest";
import {
  Interrupt,
  type InterventionState,
  OperatorMessage,
  Release,
  Steer,
} from "@usine/core/attempt/channel";
import { Deferred, Effect, Exit, Fiber, Option, Queue, Scope, Schema } from "effect";
import { TestClock } from "effect/testing";
import { AgentBlockedError, type OnDelivery, RestartState } from "../../../src/runtime.ts";
import { sessionChannel } from "../../../src/harness/session.ts";
import { sessionConversation } from "../../../src/harness/conversation.ts";
import {
  child,
  policyOf,
  conversation,
  testReceipts,
  noDelivery,
  ciWatch,
  capturedLogs,
  logged,
} from "./fixture.ts";

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
