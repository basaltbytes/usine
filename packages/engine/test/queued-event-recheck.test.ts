import { assert, describe, it } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Effect, Layer, Option, Path, Ref, Schedule, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { RunEngine } from "../src/engine/engine.ts";
import { TriggerCondition } from "../src/trigger-condition.ts";
import { runIdFor } from "../src/engine/submission.ts";
import {
  approvalEvent,
  uiApproval,
  type AttemptPlan,
  conditionLayer,
  engineLayer,
  executorLayer,
  stepResult,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

describe("queued Event trigger re-check", () => {
  it.live("revokes a queued Event whose trigger no longer holds when the Run ahead closes", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(gate).pipe(Effect.as(stepResult("first result"))),
        ]);
        // The finisher scenario: the closing Run pushed a commit (Event B) and
        // then relabeled, so B's trigger is false once A closes.
        const runtime = engineLayer(
          directory,
          executorLayer(plans),
          conditionLayer(Effect.succeed(false)),
        );
        const path = yield* Path.Path;
        const database = path.join(directory, ".usine", "runtime.sqlite");
        const ignoredReason = (eventId: string) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql`
              SELECT reason
              FROM usine_ignored_events
              WHERE event_id = ${eventId}
            `;
            return yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ reason: Schema.String })),
            )(rows);
          }).pipe(Effect.provide(SqliteClient.layer({ filename: database })));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const first = yield* engine.submit(submission({ number: 20, approval: "required" }));
          assert.strictEqual(first._tag, "Claimed");
          if (first._tag !== "Claimed") return;
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Waiting");
          yield* engine.approve(first.runId, approvalEvent(20), uiApproval);
          yield* waitFor(
            engine,
            first.runId,
            ({ run, attempts }) => run.state._tag === "Running" && attempts.length === 1,
          );

          const second = submission({ number: 21, approval: "required" });
          assert.strictEqual((yield* engine.submit(second))._tag, "Queued");

          yield* Deferred.succeed(gate, undefined);
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Succeeded");
          let ignored = yield* ignoredReason(second.event.id);
          for (let poll = 0; poll < 500 && ignored.length === 0; poll += 1) {
            yield* Effect.sleep("10 millis");
            ignored = yield* ignoredReason(second.event.id);
          }
          assert.deepStrictEqual(ignored, [{ reason: "revoked" }]);
          const resubmitted = yield* engine.submit(second);
          assert.strictEqual(resubmitted._tag, "Ignored");
          if (resubmitted._tag === "Ignored") assert.strictEqual(resubmitted.reason, "revoked");
          // No Run ever opened for the dropped Event, so no approval was asked.
          const missing = yield* Effect.flip(engine.inspect(yield* runIdFor(second)));
          assert.strictEqual(missing._tag, "RunNotFoundError");
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("preserves newer queued work when an older trigger re-check returns false", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const finishFirst = yield* Deferred.make<void>();
        const finishThird = yield* Deferred.make<void>();
        const checking = yield* Deferred.make<void>();
        const checked = yield* Deferred.make<boolean>();
        const second = submission({ number: 31 });
        const fourth = submission({ number: 33 });
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(finishFirst).pipe(Effect.as(stepResult("first"))),
          Deferred.await(finishThird).pipe(Effect.as(stepResult("third"))),
          Effect.succeed(stepResult("fourth")),
        ]);
        const runtime = engineLayer(
          directory,
          executorLayer(plans),
          Layer.succeed(TriggerCondition)({
            holds: (candidate) =>
              candidate.event.id === second.event.id
                ? Deferred.succeed(checking, undefined).pipe(
                    Effect.andThen(Deferred.await(checked)),
                  )
                : Effect.succeed(true),
          }),
        );
        const path = yield* Path.Path;
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const first = yield* engine.submit(submission({ number: 30 }));
          assert(first._tag === "Claimed");
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Running");
          assert.strictEqual((yield* engine.submit(second))._tag, "Queued");
          yield* Deferred.succeed(finishFirst, undefined);
          yield* Deferred.await(checking);

          const third = yield* engine.submit(submission({ number: 32 }));
          assert(third._tag === "Claimed");
          yield* waitFor(engine, third.runId, ({ run }) => run.state._tag === "Running");
          assert.strictEqual((yield* engine.submit(fourth))._tag, "Queued");
          yield* Deferred.succeed(checked, false);

          // Wait for B's delayed revocation to commit before allowing C to close.
          const revoked = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return (
              (yield* sql`SELECT event_id FROM usine_ignored_events
              WHERE event_id = ${second.event.id}`).length > 0
            );
          }).pipe(
            Effect.provide(
              SqliteClient.layer({
                filename: path.join(directory, ".usine", "runtime.sqlite"),
              }),
            ),
          );
          let settled = yield* revoked;
          for (let poll = 0; poll < 500 && !settled; poll += 1) {
            yield* Effect.sleep("10 millis");
            settled = yield* revoked;
          }
          assert(settled);
          assert.strictEqual((yield* engine.submit(fourth))._tag, "Queued");
          yield* Deferred.succeed(finishThird, undefined);
          const fourthId = yield* runIdFor(fourth);
          yield* engine.inspect(fourthId).pipe(
            Effect.retry({
              while: (error) => error._tag === "RunNotFoundError",
              times: 500,
              schedule: Schedule.spaced("10 millis"),
            }),
          );
          const finished = yield* waitFor(
            engine,
            fourthId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 1);
          assert(Option.isSome(finished.step.result));
          assert.strictEqual(finished.step.result.value.message, "fourth");
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("opens a queued Event whose trigger still holds behind its own approval gate", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(gate).pipe(Effect.as(stepResult("first result"))),
          Effect.succeed(stepResult("queued result")),
        ]);
        const runtime = engineLayer(directory, executorLayer(plans));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const first = yield* engine.submit(submission({ number: 22, approval: "required" }));
          assert.strictEqual(first._tag, "Claimed");
          if (first._tag !== "Claimed") return;
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Waiting");
          yield* engine.approve(first.runId, approvalEvent(22), uiApproval);
          yield* waitFor(
            engine,
            first.runId,
            ({ run, attempts }) => run.state._tag === "Running" && attempts.length === 1,
          );

          const second = submission({ number: 23, approval: "required" });
          assert.strictEqual((yield* engine.submit(second))._tag, "Queued");

          yield* Deferred.succeed(gate, undefined);
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Succeeded");
          // The first approval covered only its own Run: the queued Event's
          // Run parks on the gate again before any Attempt.
          const secondRunId = yield* runIdFor(second);
          const parked = yield* waitFor(
            engine,
            secondRunId,
            ({ run }) => run.state._tag === "Waiting",
          );
          assert.strictEqual(parked.attempts.length, 0);
          yield* engine.approve(secondRunId, approvalEvent(23), uiApproval);
          const finished = yield* waitFor(
            engine,
            secondRunId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert(Option.isSome(finished.step.result));
          assert.strictEqual(finished.step.result.value.message, "queued result");
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );
});
