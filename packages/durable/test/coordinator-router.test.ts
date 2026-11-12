import { assert, describe, it } from "@effect/vitest";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Deferred, Effect, Fiber, Layer, Option } from "effect";
import { AttemptRequest, AttemptRuntime, ParentReported } from "../src/attempt-runtime.ts";
import type { CoordinatorKind } from "@usine/core/agent";
import { AttemptJournal } from "../src/coordinator/journal.ts";
import { PiAttemptRuntime, routerLayer } from "../src/coordinator/router.ts";
import { CoordinatorRuntime } from "../src/coordinator/runtime.ts";
import { WakeUp } from "../src/coordinator/wake-up.ts";
import {
  stubAttemptRuntime,
  stubChildBackendLayer,
  StubChildren,
  StubStorage,
} from "../src/testing.ts";
import {
  attemptRequest,
  recordingSink,
  slowToInterrupt,
  sqliteJournal,
  temporaryDatabase,
  trace,
} from "./support.ts";

const withCoordinator = (attemptId: string, coordinator: CoordinatorKind) => {
  const request = attemptRequest(attemptId);
  return AttemptRequest.make({
    ...request,
    spec: AttemptChannel.RunSpec.make({ ...request.spec, coordinator }),
  });
};

/**
 * The router over a stub Pi runtime on `storage` and a coordinator with stub children, on
 * `journal`. Each layer built is one orchestrator process.
 */
const routed = (storage: StubStorage, journal: Layer.Layer<AttemptJournal>) =>
  routerLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(PiAttemptRuntime, Effect.service(AttemptRuntime)).pipe(
          Layer.provide(stubAttemptRuntime(storage)),
        ),
        CoordinatorRuntime.layer.pipe(Layer.provide(WakeUp.rules)),
      ),
    ),
    Layer.provideMerge(journal),
    Layer.provideMerge(stubChildBackendLayer),
  );

/** Holds each `open` of `journal` until `release` completes, after completing `opening`. */
const holdingOpen =
  (opening: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  (journal: Layer.Layer<AttemptJournal>) =>
    Layer.effect(
      AttemptJournal,
      Effect.gen(function* () {
        const inner = yield* AttemptJournal;
        return AttemptJournal.of({
          ...inner,
          open: (request) =>
            Deferred.succeed(opening, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(inner.open(request)),
            ),
        });
      }),
    ).pipe(Layer.provide(journal));

const unresponsive = (reason: string) =>
  AttemptChannel.WorkerUnresponsive.make({
    worker: WorkerName.make("local"),
    lastAnsweredAt: DateTime.makeUnsafe("2026-11-11T08:59:00Z"),
    reason,
  });

describe("AttemptRuntime router", () => {
  it.live(
    "keeps each Attempt on the coordinator it started with when its coordinator kind changes across a restart",
    () =>
      Effect.gen(function* () {
        const database = yield* temporaryDatabase;
        const storage = new StubStorage();
        const coordinated = withCoordinator("router/coordinated", "events");
        const parented = withCoordinator("router/parented", "session");
        const [first, parentReport] = yield* Effect.gen(function* () {
          const attempts = yield* AttemptRuntime;
          const execution = yield* Effect.forkChild(
            attempts.execute(coordinated, recordingSink().sink),
          );
          const child = yield* (yield* StubChildren).next;
          yield* child.reply("Done by the child.");
          return [
            yield* Fiber.join(execution),
            yield* attempts.execute(parented, recordingSink().sink),
          ] as const;
        }).pipe(Effect.provide(routed(storage, sqliteJournal(database))));

        yield* Effect.gen(function* () {
          const attempts = yield* AttemptRuntime;
          const journal = yield* AttemptJournal;
          const again = yield* attempts.execute(
            withCoordinator("router/coordinated", "session"),
            recordingSink().sink,
          );
          const parentAgain = yield* attempts.execute(
            withCoordinator("router/parented", "events"),
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
            Option.map(parentedRequest, ({ spec }) => spec.coordinator),
            Option.some("session"),
          );
          assert.isTrue(Option.isNone(parentedJournal));
        }).pipe(Effect.provide(routed(storage, sqliteJournal(database))));
      }).pipe(Effect.scoped),
  );

  it.live("sends a coordinated Attempt's harvest, request, and cancel to the coordinator", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const storage = new StubStorage();
      yield* Effect.gen(function* () {
        const attempts = yield* AttemptRuntime;
        const children = yield* StubChildren;
        const reported = withCoordinator("router/harvested", "events");
        const execution = yield* Effect.forkChild(attempts.execute(reported, recordingSink().sink));
        const child = yield* children.next;
        yield* child.reply("Done by the child.");
        const report = yield* Fiber.join(execution);
        const finished = yield* attempts.finished(reported.spec.attemptId);
        const kept = yield* attempts.request(reported.spec.attemptId);
        assert.deepStrictEqual(finished, Option.some(ParentReported.make({ report })));
        assert.deepStrictEqual(
          Option.map(kept, ({ spec }) => spec.coordinator),
          Option.some("events"),
        );

        const canceled = withCoordinator("router/canceled", "events");
        const recording = recordingSink();
        const running = yield* Effect.forkChild(
          attempts.execute(canceled, slowToInterrupt(recording.sink)),
        );
        const working = yield* children.next;
        yield* attempts.cancel(canceled.spec.attemptId);
        // `cancel` returns only after the child stopped and the channel ended.
        const stoppedOnReturn = yield* working.interrupted.pipe(Effect.timeoutOption(0));
        const lastOnReturn = trace(recording.outbound()).at(-1);
        const failure = yield* Fiber.join(running).pipe(Effect.flip);

        assert.isTrue(Option.isSome(stoppedOnReturn));
        assert.strictEqual(lastOnReturn, "Interrupted");
        assert.strictEqual(failure._tag, "AgentFailure");
        assert.strictEqual(trace(recording.outbound()).at(-1), "Interrupted");
        assert.isFalse(storage.tasks.has(reported.spec.attemptId));
        assert.isFalse(storage.tasks.has(canceled.spec.attemptId));
      }).pipe(Effect.provide(routed(storage, sqliteJournal(database))));
    }).pipe(Effect.scoped),
  );

  it.live("gives a Worker notice that came before execute to the Attempt's coordinator", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const storage = new StubStorage();
      const request = withCoordinator("router/early-notice", "events");
      const recording = recordingSink();
      const attachedBeforeExecute = yield* Effect.gen(function* () {
        const attempts = yield* AttemptRuntime;
        const attached = yield* Effect.forkChild(attempts.attached(request.spec.attemptId));
        yield* attempts.notify(request.spec.attemptId, unresponsive("probe timed out"));
        const execution = yield* Effect.forkChild(attempts.execute(request, recording.sink));
        const child = yield* (yield* StubChildren).next;
        const attachedExit = yield* Fiber.join(attached).pipe(Effect.timeoutOption("1 second"));
        yield* child.reply("Done.");
        yield* Fiber.join(execution);
        return attachedExit;
      }).pipe(Effect.provide(routed(storage, sqliteJournal(database))));

      assert.isTrue(Option.isSome(attachedBeforeExecute));
      assert.deepStrictEqual(trace(recording.outbound()).slice(0, 2), [
        "Started",
        "WorkerUnresponsive",
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("relays a Worker notice that arrives while the coordinator opens the Attempt", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const storage = new StubStorage();
      const request = withCoordinator("router/opening-notice", "events");
      const recording = recordingSink();
      const opening = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const attempts = yield* AttemptRuntime;
        const execution = yield* Effect.forkChild(attempts.execute(request, recording.sink));
        yield* Deferred.await(opening);
        yield* attempts.notify(request.spec.attemptId, unresponsive("while opening"));
        yield* Deferred.succeed(release, undefined);
        const child = yield* (yield* StubChildren).next;
        yield* child.reply("Done.");
        yield* Fiber.join(execution);
      }).pipe(
        Effect.provide(
          routed(storage, sqliteJournal(database).pipe(holdingOpen(opening, release))),
        ),
      );

      assert.deepStrictEqual(trace(recording.outbound()).slice(0, 2), [
        "Started",
        "WorkerUnresponsive",
      ]);
    }).pipe(Effect.scoped),
  );
});
