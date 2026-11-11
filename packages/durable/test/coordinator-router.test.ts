import { assert, describe, it } from "@effect/vitest";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Fiber, Layer, Option } from "effect";
import { AttemptRequest, AttemptRuntime, ParentReported } from "../src/attempt-runtime.ts";
import type { ParentKind } from "@usine/core/agent";
import { AttemptJournal } from "../src/coordinator/journal.ts";
import { memoryAttemptJournalLayer } from "../src/coordinator/memory.ts";
import { PiAttemptRuntime, routerLayer } from "../src/coordinator/router.ts";
import { CoordinatorRuntime } from "../src/coordinator/runtime.ts";
import { WakeUp } from "../src/coordinator/wake-up.ts";
import {
  stubAttemptRuntime,
  stubChildBackendLayer,
  StubChildren,
  StubStorage,
} from "../src/testing.ts";
import { attemptRequest, recordingSink, trace } from "./support.ts";

const withParent = (attemptId: string, parent: ParentKind) => {
  const request = attemptRequest(attemptId);
  return AttemptRequest.make({
    ...request,
    spec: AttemptChannel.RunSpec.make({ ...request.spec, parent }),
  });
};

/** The router over a stub Pi runtime on `storage` and a coordinator with stub children. */
const routed = (storage: StubStorage) =>
  routerLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(PiAttemptRuntime, Effect.service(AttemptRuntime)).pipe(
          Layer.provide(stubAttemptRuntime(storage)),
        ),
        CoordinatorRuntime.layer.pipe(Layer.provide(WakeUp.rules)),
      ),
    ),
    Layer.provideMerge(memoryAttemptJournalLayer),
    Layer.provideMerge(stubChildBackendLayer),
  );

describe("AttemptRuntime router", () => {
  it.effect("keeps each Attempt on the coordinator it started with when its parent changes", () =>
    Effect.gen(function* () {
      const storage = new StubStorage();
      yield* Effect.gen(function* () {
        const attempts = yield* AttemptRuntime;
        const journal = yield* AttemptJournal;
        const coordinated = withParent("router/coordinated", "none");
        const execution = yield* Effect.forkChild(
          attempts.execute(coordinated, recordingSink().sink),
        );
        const child = yield* (yield* StubChildren).next;
        yield* child.reply("Done by the child.");
        const first = yield* Fiber.join(execution);
        const again = yield* attempts.execute(
          withParent("router/coordinated", "pi"),
          recordingSink().sink,
        );

        const parented = withParent("router/parented", "pi");
        const parentReport = yield* attempts.execute(parented, recordingSink().sink);
        const parentAgain = yield* attempts.execute(
          withParent("router/parented", "none"),
          recordingSink().sink,
        );
        const coordinatedLive = yield* attempts.isLive(coordinated.spec.attemptId);
        const parentedRequest = yield* attempts.request(parented.spec.attemptId);
        const parentedJournal = yield* journal.load(parented.spec.attemptId);

        assert.strictEqual(first.message, "Done by the child.");
        assert.strictEqual(again.message, "Done by the child.");
        assert.isFalse(storage.tasks.has(coordinated.spec.attemptId));
        assert.strictEqual(parentReport.message, `Completed: ${parented.spec.task}`);
        assert.strictEqual(parentAgain.message, parentReport.message);
        assert.isFalse(coordinatedLive);
        assert.deepStrictEqual(
          Option.map(parentedRequest, ({ spec }) => spec.parent),
          Option.some("pi"),
        );
        assert.isTrue(Option.isNone(parentedJournal));
      }).pipe(Effect.provide(routed(storage)));
    }),
  );

  it.effect("sends a coordinated Attempt's harvest, request, and cancel to the coordinator", () =>
    Effect.gen(function* () {
      const storage = new StubStorage();
      yield* Effect.gen(function* () {
        const attempts = yield* AttemptRuntime;
        const children = yield* StubChildren;
        const reported = withParent("router/harvested", "none");
        const execution = yield* Effect.forkChild(attempts.execute(reported, recordingSink().sink));
        const child = yield* children.next;
        yield* child.reply("Done by the child.");
        const report = yield* Fiber.join(execution);
        const finished = yield* attempts.finished(reported.spec.attemptId);
        const kept = yield* attempts.request(reported.spec.attemptId);
        assert.deepStrictEqual(finished, Option.some(ParentReported.make({ report })));
        assert.deepStrictEqual(
          Option.map(kept, ({ spec }) => spec.parent),
          Option.some("none"),
        );

        const canceled = withParent("router/canceled", "none");
        const recording = recordingSink();
        const running = yield* Effect.forkChild(attempts.execute(canceled, recording.sink));
        const working = yield* children.next;
        yield* attempts.cancel(canceled.spec.attemptId);
        yield* working.interrupted;
        const failure = yield* Fiber.join(running).pipe(Effect.flip);

        assert.strictEqual(failure._tag, "AgentFailure");
        assert.strictEqual(trace(recording.outbound()).at(-1), "Interrupted");
        assert.isFalse(storage.tasks.has(reported.spec.attemptId));
        assert.isFalse(storage.tasks.has(canceled.spec.attemptId));
      }).pipe(Effect.provide(routed(storage)));
    }),
  );

  it.effect("gives a Worker notice that came before execute to the Attempt's coordinator", () =>
    Effect.gen(function* () {
      const storage = new StubStorage();
      const request = withParent("router/early-notice", "none");
      const recording = recordingSink();
      yield* Effect.gen(function* () {
        const attempts = yield* AttemptRuntime;
        yield* attempts.notify(
          request.spec.attemptId,
          AttemptChannel.WorkerUnresponsive.make({
            worker: WorkerName.make("local"),
            lastAnsweredAt: DateTime.makeUnsafe("2026-11-11T08:59:00Z"),
            reason: "probe timed out",
          }),
        );
        const execution = yield* Effect.forkChild(attempts.execute(request, recording.sink));
        const child = yield* (yield* StubChildren).next;
        yield* child.reply("Done.");
        yield* Fiber.join(execution);
      }).pipe(Effect.provide(routed(storage)));

      assert.deepStrictEqual(trace(recording.outbound()).slice(0, 2), [
        "Started",
        "WorkerUnresponsive",
      ]);
    }),
  );
});
