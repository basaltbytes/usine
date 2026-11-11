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

const report = (child: number, length: number) =>
  ChildReported.make({
    child: ChildSessionCount.make(child),
    report: "r".repeat(length),
    answeredOperator: false,
    reserved: Option.none(),
  });

/**
 * Returns the snapshot after child 1 reported `first` and child 2 left `output`, with a task and
 * payload of the given lengths.
 */
const journalWith = (sizes: {
  readonly task: number;
  readonly payload: number;
  readonly first: number;
  readonly output: number;
}) =>
  Effect.gen(function* () {
    const journal = yield* AttemptJournal;
    const base = attemptRequest("context/sizes");
    const spec = AttemptChannel.RunSpec.make({
      ...base.spec,
      task: AttemptTask.make("t".repeat(sizes.task)),
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
    const one = ChildSessionCount.make(1);
    const two = ChildSessionCount.make(2);
    yield* journal.open(StoredRequest.make({ spec, worker: base.worker, cwd: base.cwd }));
    yield* journal.transition(attemptId, JournalRevision.make(0), step(1));
    yield* journal.startDelegation(attemptId, one);
    const firstReport = yield* encodeEvent(report(1, sizes.first));
    yield* journal.settleDelegation(attemptId, one, EncodedEvent.make(firstReport));
    yield* journal.transition(attemptId, JournalRevision.make(1), step(2));
    yield* journal.startDelegation(attemptId, two);
    yield* journal.saveProgress(
      attemptId,
      two,
      OutputSaved.make({ output: "o".repeat(sizes.output) }),
    );
    const snapshot = yield* journal.load(attemptId);
    if (Option.isNone(snapshot)) return yield* Effect.die(new Error("no journal"));
    return snapshot.value;
  }).pipe(Effect.provide(memoryAttemptJournalLayer));

describe("AttemptContext.build", () => {
  it.effect("stays within the cap for the sizes of run 2c33c58d", () =>
    Effect.gen(function* () {
      const snapshot = yield* journalWith({
        task: 11_900,
        payload: 14_700,
        first: 112,
        output: 30_000,
      });
      const event = report(2, 3_413);
      const context = yield* buildAttemptContext(snapshot, event);
      const encoded = yield* contextJson(context);

      assert.isAtMost(encoded.length, CONTEXT_CHARACTERS);
      assert.strictEqual(context.task.length, 4_000);
      assert.strictEqual(context.output.length, 2_000);
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
          { child: 2, status: "running", end: Option.none(), report: Option.none() },
        ],
      );
    }),
  );

  it.effect("shortens the task, output, and earlier report to fit, and keeps the event whole", () =>
    Effect.gen(function* () {
      const snapshot = yield* journalWith({
        task: 50_000,
        payload: 0,
        first: 30_000,
        output: 60_000,
      });
      const event = report(2, 9_000);
      const context = yield* buildAttemptContext(snapshot, event);
      const encoded = yield* contextJson(context);

      assert.isAtMost(encoded.length, CONTEXT_CHARACTERS);
      assert.deepStrictEqual(context.event, event);
    }),
  );
});
