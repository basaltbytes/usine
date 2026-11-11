import { assert, describe, it } from "@effect/vitest";
import { ChildSessionCount } from "@usine/core/agent/session";
import { AttemptTask } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Option, Schema } from "effect";
import { StoredRequest } from "../src/attempt-runtime.ts";
import {
  AttemptContext,
  ChildReported,
  CoordinatorEvent,
} from "../src/attempt/coordinator/rules.ts";
import { buildAttemptContext, CONTEXT_CHARACTERS } from "../src/coordinator/context.ts";
import {
  AttemptJournal,
  Delegate,
  Delegation,
  EncodedDecision,
  EncodedEvent,
  EncodedState,
  JournalRevision,
  OutputSaved,
  Transition,
} from "../src/coordinator/journal.ts";
import { memoryAttemptJournalLayer } from "../src/coordinator/memory.ts";
import { attemptRequest } from "./support.ts";

const encodeEvent = Schema.encodeEffect(Schema.toCodecJson(CoordinatorEvent));
const contextJson = Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(AttemptContext)));

/** A text of `length` characters whose first half is `start` and second half is `end`. */
const halves = (length: number, start: string, end: string) =>
  start.repeat(Math.ceil(length / 2)) + end.repeat(Math.floor(length / 2));

/** The task of `length` characters: "a" in its first half and "z" in its second. */
const task = (length: number) => halves(length, "a", "z");

/** The output of `length` characters: "s" in its first half and "e" in its second. */
const output = (length: number) => halves(length, "s", "e");

const report = (child: number, length: number) =>
  ChildReported.make({
    child: ChildSessionCount.make(child),
    report: "r".repeat(length),
    answeredOperator: false,
    reserved: Option.none(),
  });

/**
 * Returns the snapshot in which a child reported each of `earlier` in order, then the last child
 * left `output` and ended with `event`, as the coordinator records it before handling `event`. The
 * task, output, and payload have the given lengths; the task and output are built with `task` and
 * `output`.
 */
const journalWith = (sizes: {
  readonly task: number;
  readonly payload: number;
  readonly earlier: ReadonlyArray<number>;
  readonly output: number;
  readonly event: ChildReported;
}) =>
  Effect.gen(function* () {
    const journal = yield* AttemptJournal;
    const base = attemptRequest("context/sizes");
    const spec = AttemptChannel.RunSpec.make({
      ...base.spec,
      task: AttemptTask.make(task(sizes.task)),
      payload: { body: "p".repeat(sizes.payload) },
      outcomeLabels: ["ready-for-review"],
      requiresCi: true,
    });
    const attemptId = spec.attemptId;
    const step = (number: number) =>
      Transition.make({
        event: EncodedEvent.make({ _tag: "step" }),
        decision: EncodedDecision.make({ _tag: "step" }),
        state: EncodedState.make({ _tag: "step" }),
        intents: [
          Delegate.make({
            delegation: Delegation.make({
              number: ChildSessionCount.make(number),
              assignment: Option.some("Continue the task."),
            }),
          }),
        ],
        outbound: [],
      });
    yield* journal.open(StoredRequest.make({ spec, worker: base.worker, cwd: base.cwd }));
    const ended = [...sizes.earlier.map((length, index) => report(index + 1, length)), sizes.event];
    for (const [index, event] of ended.entries()) {
      const child = ChildSessionCount.make(index + 1);
      yield* journal.transition(attemptId, JournalRevision.make(index), step(child));
      yield* journal.startDelegation(attemptId, child);
      if (event === sizes.event)
        yield* journal.saveProgress(
          attemptId,
          child,
          OutputSaved.make({ output: output(sizes.output) }),
        );
      const encoded = yield* encodeEvent(event);
      yield* journal.settleDelegation(attemptId, child, EncodedEvent.make(encoded));
    }
    const snapshot = yield* journal.load(attemptId);
    if (Option.isNone(snapshot)) return yield* Effect.die(new Error("no journal"));
    return snapshot.value;
  }).pipe(Effect.provide(memoryAttemptJournalLayer));

describe("AttemptContext.build", () => {
  it.effect("stays within the cap for the sizes of run 2c33c58d", () =>
    Effect.gen(function* () {
      const event = report(2, 3_413);
      const snapshot = yield* journalWith({
        task: 11_900,
        payload: 14_700,
        earlier: [112],
        output: 30_000,
        event,
      });
      const context = yield* buildAttemptContext(snapshot, event);
      const encoded = yield* contextJson(context);

      assert.isAtMost(encoded.length, CONTEXT_CHARACTERS);
      // The start of the task and the end of the output.
      assert.strictEqual(context.task, "a".repeat(4_000));
      assert.strictEqual(context.output, "e".repeat(2_000));
      assert.deepStrictEqual(context.outcomeLabels, ["ready-for-review"]);
      assert.isTrue(context.requiresCi);
      assert.deepStrictEqual(context.event, event);
      assert.deepStrictEqual(
        context.delegations.map(({ child, status, end, report }) => ({
          child,
          status,
          end,
          report: Option.map(report, (text) => text.length),
        })),
        [
          { child: 1, status: "ended", end: Option.some("reported"), report: Option.some(112) },
          { child: 2, status: "ended", end: Option.some("reported"), report: Option.none() },
        ],
      );
    }),
  );

  it.effect("shortens the task first to fit, keeping its start, and keeps the event whole", () =>
    Effect.gen(function* () {
      const event = report(2, 9_000);
      const snapshot = yield* journalWith({
        task: 50_000,
        payload: 0,
        earlier: [30_000],
        output: 60_000,
        event,
      });
      const context = yield* buildAttemptContext(snapshot, event);
      const encoded = yield* contextJson(context);

      assert.isAtMost(encoded.length, CONTEXT_CHARACTERS);
      assert.deepStrictEqual(context.event, event);
      // Shortening the task alone fits the cap, so the output and the report keep their limits.
      assert.isAbove(context.task.length, 0);
      assert.isBelow(context.task.length, 4_000);
      assert.strictEqual(context.task, "a".repeat(context.task.length));
      assert.strictEqual(context.output, "e".repeat(2_000));
      assert.deepStrictEqual(
        context.delegations.map(({ report }) => Option.map(report, (text) => text.length)),
        [Option.some(4_000), Option.none()],
      );
    }),
  );

  it.effect(
    "keeps the latest two reports up to 4,000 characters and earlier ones as one line",
    () =>
      Effect.gen(function* () {
        const event = report(3, 3_000);
        const snapshot = yield* journalWith({
          task: 100,
          payload: 0,
          earlier: [5_000, 5_000],
          output: 0,
          event,
        });
        const context = yield* buildAttemptContext(snapshot, event);

        assert.deepStrictEqual(context.event, event);
        assert.deepStrictEqual(
          context.delegations.map(({ child, status, report }) => ({
            child,
            status,
            report: Option.map(report, (text) => text.length),
          })),
          [
            // 160 characters and an ellipsis.
            { child: 1, status: "ended", report: Option.some(161) },
            { child: 2, status: "ended", report: Option.some(4_000) },
            // The event carries the handled child's report.
            { child: 3, status: "ended", report: Option.none() },
          ],
        );
      }),
  );

  it.effect("shortens the output, then the reports, when shortening the task isn't enough", () =>
    Effect.gen(function* () {
      const event = report(3, 12_000);
      const snapshot = yield* journalWith({
        task: 100,
        payload: 0,
        earlier: [5_000, 5_000],
        output: 2_000,
        event,
      });
      const context = yield* buildAttemptContext(snapshot, event);
      const encoded = yield* contextJson(context);
      const [first, second, handled] = context.delegations.map(({ report }) =>
        Option.getOrElse(
          Option.map(report, (text) => text.length),
          () => 0,
        ),
      );

      assert.isAtMost(encoded.length, CONTEXT_CHARACTERS);
      assert.deepStrictEqual(context.event, event);
      assert.strictEqual(context.task, "");
      assert.strictEqual(context.output, "");
      // The report shortening keeps at least one line of each report.
      assert.strictEqual(first, 160);
      assert.isAbove(second ?? 0, 160);
      assert.isBelow(second ?? 0, 4_000);
      assert.strictEqual(handled, 0);
    }),
  );

  it.effect("shortens the output from its start once the task is empty", () =>
    Effect.gen(function* () {
      const event = report(1, 14_500);
      const snapshot = yield* journalWith({
        task: 100,
        payload: 0,
        earlier: [],
        output: 2_000,
        event,
      });
      const context = yield* buildAttemptContext(snapshot, event);
      const encoded = yield* contextJson(context);

      assert.isAtMost(encoded.length, CONTEXT_CHARACTERS);
      assert.deepStrictEqual(context.event, event);
      assert.strictEqual(context.task, "");
      // Part of the output still fits, and it's the end of the output.
      assert.isAbove(context.output.length, 0);
      assert.isBelow(context.output.length, 2_000);
      assert.strictEqual(context.output, output(2_000).slice(-context.output.length));
    }),
  );
});
