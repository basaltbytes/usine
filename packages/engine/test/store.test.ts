import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AttemptChannel,
  AttemptFailure,
  Event,
  Item,
  Loop,
  Repository,
  Run,
  Step,
  Worker,
} from "@usine/core";
import { DateTime, Effect, FileSystem, Option } from "effect";
import { localSqliteLayer } from "../src/database/local-sqlite.ts";
import { InstanceDirectory, Submission } from "../src/model.ts";
import { RunStore } from "../src/store/store.ts";

describe("run store", () => {
  it.live("commits the failed state with the capped Attempt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-" }),
      );
      const event = new Event.Event({
        id: Event.EventId.make("store-event"),
        dedupKey: Event.DedupKey.make("store/event/revision"),
        payload: {},
        receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
      });
      const submission = new Submission({
        event,
        itemKey: Item.ItemKey.make("store-item"),
        loop: Loop.LoopName.make("store-loop"),
        step: Step.StepName.make("store-step"),
        approval: "none",
        repository: Repository.Name.make("basaltbytes/usine"),
        revision: Repository.Revision.make("store-revision"),
        task: AttemptChannel.Task.make("Run the store test"),
      });
      const runId = Run.RunId.make("store-run");
      const failure = new AttemptFailure.InfraFailure({
        message: "offline",
        cause: new Error("offline"),
      });

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        for (let number = 1; number <= 3; number += 1) {
          const started = yield* store.beginAttempt(runId, Worker.Name.make("local"));
          assert.strictEqual(started._tag, "AttemptStarted");
          if (started._tag !== "AttemptStarted") return;
          assert.strictEqual(
            yield* store.failAttempt(started.execution.attempt, failure),
            number < 3,
          );
        }
        const snapshot = yield* store.snapshot(runId);
        assert.strictEqual(snapshot.run.state._tag, "Failed");
        assert.strictEqual(snapshot.attempts.length, 3);
        assert(snapshot.attempts.every((attempt) => Option.isSome(attempt.outcome)));
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a run closed while queued instead of starting an attempt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-store-closed-" }),
      );
      const submission = new Submission({
        event: new Event.Event({
          id: Event.EventId.make("closed-event"),
          dedupKey: Event.DedupKey.make("closed/event/revision"),
          payload: {},
          receivedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
        }),
        itemKey: Item.ItemKey.make("closed-item"),
        loop: Loop.LoopName.make("closed-loop"),
        step: Step.StepName.make("closed-step"),
        approval: "none",
        repository: Repository.Name.make("basaltbytes/usine"),
        revision: Repository.Revision.make("closed-revision"),
        task: AttemptChannel.Task.make("Close before starting"),
      });
      const runId = Run.RunId.make("closed-run");

      yield* Effect.gen(function* () {
        const store = yield* RunStore;
        yield* store.recordAndClaim(submission, runId);
        // With worker capacity, a run routinely closes between claim and
        // begin. That is a routine outcome, never a defect.
        const outcome = yield* store.cancel(runId);
        assert.strictEqual(outcome._tag, "Canceled");
        const started = yield* store.beginAttempt(runId, Worker.Name.make("local"));
        assert.strictEqual(started._tag, "RunClosed");
        const snapshot = yield* store.snapshot(runId);
        assert.strictEqual(snapshot.attempts.length, 0);
      }).pipe(Effect.provide(RunStore.layer), Effect.provide(localSqliteLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
