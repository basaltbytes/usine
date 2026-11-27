import { assert, describe, it } from "@effect/vitest";
import { BackgroundWork } from "@usine/core/agent/session";
import { Interrupt, OperatorMessage, Release, Steer } from "@usine/core/attempt/channel";
import { Clock, Deferred, Duration, Effect, Fiber, Option, Predicate } from "effect";
import { TestClock } from "effect/testing";
import { RestartState } from "../../../src/runtime.ts";
import { sessionChannel } from "../../../src/harness/session.ts";
import { BACKGROUND_TURN_GRACE } from "../../../src/harness/conversation/background.ts";
import { sessionConversation } from "../../../src/harness/conversation/conversation.ts";
import {
  child,
  policyOf,
  conversation,
  testReceipts,
  noDelivery,
  ciWatch,
  capturedLogs,
  loggedTimes,
  logged,
} from "./fixture.ts";

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

  it.effect.each([
    {
      snapshot: Option.none<ReadonlyArray<BackgroundWork>>(),
      label: "unreported work",
      expectedSleeps: 1,
    },
    { snapshot: nothingRuns, label: "finished work", expectedSleeps: 2 },
  ])(
    "stops a waiting answer's timers when a later answer returns ($label)",
    ({ snapshot, expectedSleeps }) => {
      const logs = capturedLogs();
      return TestClock.testClockWith((base) => {
        const active = new Set<symbol>();
        const clock: Clock.Clock = {
          currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
          currentTimeMillis: base.currentTimeMillis,
          currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
          currentTimeNanos: base.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: base.monotonicTimeNanos,
          sleep: (duration) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                const token = Symbol();
                active.add(token);
                return token;
              }),
              () => base.sleep(duration),
              (token) =>
                Effect.sync(() => {
                  active.delete(token);
                }),
            ),
        };
        return Effect.gen(function* () {
          const session = yield* conversation(child("returned-answer"), {}, Option.some(10));
          yield* session.reportBackground(Option.some([ciWatch]));
          yield* session.finish("Waiting for CI");
          yield* session.reportBackground(snapshot);
          while (active.size < expectedSleeps) yield* Effect.yieldNow;
          yield* session.finish("CI passed");
          assert.strictEqual((yield* Fiber.join(session.result)).message, "CI passed");
          assert.strictEqual(
            active.size,
            0,
            "the earlier wait's scheduled sleeps are cancelled as soon as the final answer returns",
          );
          const cancelEntry = logs.entries.find(
            ({ logLevel, message }) =>
              logLevel === "Info" &&
              Array.isArray(message) &&
              String(message[0]).includes(
                "A later final answer cancels the previous wait for background work",
              ),
          );
          assert.isDefined(
            cancelEntry,
            "the final return logs that it cancelled the previous wait",
          );
          assert.deepStrictEqual(
            Array.isArray(cancelEntry.message) ? cancelEntry.message[1] : undefined,
            {
              sessionId: "returned-answer",
              replacedBy: "Final",
              limit: true,
              grace: expectedSleeps === 2,
            },
          );
          yield* base.adjust("10 minutes");
          assert.isFalse(
            logged(logs, "returning its answer"),
            "the earlier wait ended with its answer",
          );
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }).pipe(Effect.provide(logs.layer));
    },
  );

  it.effect("gives a replacement waiting answer its own wait limit", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("limit-replaced"), {}, Option.some(10));
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("First answer");
      yield* TestClock.adjust("8 minutes");
      yield* session.finish("Latest answer");
      yield* TestClock.adjust("2 minutes");
      assert.isUndefined(session.result.pollUnsafe(), "the first answer's limit no longer applies");
      yield* TestClock.adjust("8 minutes");
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Latest answer");
      const events = yield* session.events;
      assert.deepStrictEqual(limitsPassed(events), [true]);
    }),
  );

  it.effect("cancels the grace period after repeated empty snapshots when a new turn starts", () =>
    Effect.gen(function* () {
      const session = yield* conversation(child("repeated-grace-cancelled"));
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("First answer");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust("1 minute");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust("1 minute");
      yield* session.turnStarted;
      yield* session.reportBackground(Option.some([ciWatch]));
      yield* session.finish("Latest answer");
      yield* TestClock.adjust("10 minutes");
      assert.isUndefined(session.result.pollUnsafe(), "no orphaned grace period ends the new wait");
      yield* session.reportBackground(nothingRuns);
      yield* TestClock.adjust(BACKGROUND_TURN_GRACE);
      assert.strictEqual((yield* Fiber.join(session.result)).message, "Latest answer");
      const events = yield* session.events;
      assert.deepStrictEqual(limitsPassed(events), [false]);
    }),
  );

  it.effect(
    "reports a recovery's continuation after a waiting answer replaced the idle report",
    () =>
      Effect.gen(function* () {
        const session = yield* conversation(child("idle-waiting-recovered"), {
          held: true,
          idle: Option.some("Waiting for review"),
        });
        yield* session.turnStarted;
        yield* session.reportBackground(Option.some([ciWatch]));
        yield* session.finish("Watching CI");
        yield* session.intervene(Release.make(), noDelivery);
        const reported = yield* session.emitted;
        assert.deepStrictEqual(reported, ["SessionIdle", "BackgroundWorkUpdated"]);
        const inputs: Array<string> = [];
        const send = (message: string) =>
          Effect.sync(() => {
            inputs.push(message);
            return "queued" as const;
          });
        yield* session.recover([], send);
        assert.deepStrictEqual(inputs, ["Continue the task."]);
        const resumed = yield* session.emitted;
        assert.deepStrictEqual(resumed, ["SessionResumed"]);
        yield* session.recover([], send);
        const again = yield* session.emitted;
        assert.deepStrictEqual(again, [], "the continuation already resumed it");
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
