import { assert, describe, it } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { EventId } from "@usine/core/event";
import { ItemKey, ItemNumber } from "@usine/core/item";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { Deferred, Effect, Layer, Option, Path, Ref, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { RunEngine } from "../src/engine/engine.ts";
import {
  ItemContentHash,
  ItemProjection,
  ItemProjectionReader,
  ItemProjectionSource,
  ItemProjectionWriter,
} from "../src/item-projection/item-projection.ts";
import { TriggerCondition, TriggerRecheck } from "../src/trigger-condition.ts";
import { runIdFor, Submission } from "../src/engine/submission.ts";
import {
  approvalEvent,
  uiApproval,
  type AttemptPlan,
  conditionLayer,
  engineLayer,
  executorLayer,
  stepResult,
  stillMatches,
  submission,
  waitFor,
  withInstance,
} from "./support.ts";

const ignoredReason = (database: string, eventId: EventId) =>
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

describe("queued Event trigger re-check", () => {
  it.live.each([false, true])(
    "revokes queued trigger matches after one mismatch even if the next recheck would fail open (older CI fix: %s)",
    (withCiFix) =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Deferred.await(gate).pipe(Effect.as(stepResult("first result"))),
          ]);
          const rechecks = yield* Ref.make<ReadonlyArray<EventId>>([]);
          const runtime = engineLayer(
            directory,
            executorLayer(plans),
            conditionLayer((candidate) =>
              Effect.gen(function* () {
                const checked = yield* Ref.updateAndGet(rechecks, (all) => [
                  ...all,
                  candidate.event.id,
                ]);
                return checked.length === 1
                  ? TriggerRecheck.NoLongerMatches()
                  : yield* stillMatches(candidate);
              }),
            ),
          );
          const path = yield* Path.Path;
          const database = path.join(directory, ".usine", "runtime.sqlite");

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

            const fix = Submission.make({
              ...submission({ number: 21, approval: "required" }),
              ciFailureHead: Option.some(CommitSha.make("a".repeat(40))),
            });
            const older = submission({ number: 22, approval: "required" });
            const second = submission({ number: 23, approval: "required" });
            if (withCiFix) assert.strictEqual((yield* engine.submit(fix))._tag, "Queued");
            assert.strictEqual((yield* engine.submit(older))._tag, "Queued");
            assert.strictEqual((yield* engine.submit(second))._tag, "Queued");

            yield* Deferred.succeed(gate, undefined);
            yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Succeeded");
            let ignored = yield* ignoredReason(database, second.event.id);
            for (let poll = 0; poll < 500 && ignored.length === 0; poll += 1) {
              yield* Effect.sleep("10 millis");
              ignored = yield* ignoredReason(database, second.event.id);
            }
            assert.deepStrictEqual(ignored, [{ reason: "revoked" }]);
            const olderReason = yield* ignoredReason(database, older.event.id);
            assert.deepStrictEqual(olderReason, [{ reason: "revoked" }]);
            for (const candidate of [older, second]) {
              const currentRunId = yield* runIdFor(candidate);
              const missing = yield* Effect.flip(engine.inspect(currentRunId));
              assert.strictEqual(missing._tag, "RunNotFoundError");
            }
            if (withCiFix) {
              const fixRunId = yield* runIdFor(fix);
              yield* engine.inspect(fixRunId).pipe(
                Effect.retry({
                  while: (error) => error._tag === "RunNotFoundError",
                  times: 500,
                  schedule: Schedule.spaced("10 millis"),
                }),
              );
              const waiting = yield* waitFor(
                engine,
                fixRunId,
                ({ run }) => run.state._tag === "Waiting",
              );
              assert.strictEqual(waiting.attempts.length, 0);
            }
            const checked = yield* Ref.get(rechecks);
            assert.deepStrictEqual(
              checked,
              withCiFix ? [second.event.id, fix.event.id] : [second.event.id],
            );
          }).pipe(Effect.provide(runtime));
        }),
      ),
  );

  it.live(
    "revokes the queued Events of an Item its source no longer has and marks its projection gone",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Deferred.await(gate).pipe(Effect.as(stepResult("first result"))),
          ]);
          const rechecks = yield* Ref.make<ReadonlyArray<EventId>>([]);
          const runtime = engineLayer(
            directory,
            executorLayer(plans),
            conditionLayer((candidate) =>
              Ref.update(rechecks, (all) => [...all, candidate.event.id]).pipe(
                Effect.as(TriggerRecheck.ItemGone()),
              ),
            ),
          );
          const path = yield* Path.Path;
          const database = path.join(directory, ".usine", "runtime.sqlite");
          const repository = RepositoryName.make("basaltbytes/usine");
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const projections = yield* ItemProjectionReader;
            yield* (yield* ItemProjectionWriter).upsert(
              ItemProjection.make({
                itemKey: ItemKey.make("item-1"),
                repository,
                source: ItemProjectionSource.make("issue"),
                number: ItemNumber.make(1),
                contentHash: ItemContentHash.make("issue-1:open"),
                payload: { state: "OPEN" },
              }),
            );
            const first = yield* engine.submit(submission({ number: 40 }));
            assert(first._tag === "Claimed");
            yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Running");
            const older = Submission.make({
              ...submission({ number: 41 }),
              ciFailureHead: Option.some(CommitSha.make("a".repeat(40))),
            });
            const second = submission({ number: 42 });
            assert.strictEqual((yield* engine.submit(older))._tag, "Queued");
            assert.strictEqual((yield* engine.submit(second))._tag, "Queued");

            yield* Deferred.succeed(gate, undefined);
            yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Succeeded");
            const [projection] = yield* projections.list(repository, { limit: 1 }).pipe(
              Effect.repeat({
                while: ([item]) => item === undefined || Option.isNone(item.goneAt),
                schedule: Schedule.spaced("10 millis"),
                times: 500,
              }),
            );
            // The Board reads the Item as gone, with its last payload kept.
            assert(projection !== undefined && Option.isSome(projection.goneAt));
            assert.deepStrictEqual(projection.payload, { state: "OPEN" });
            for (const candidate of [older, second]) {
              const reason = yield* ignoredReason(database, candidate.event.id);
              assert.deepStrictEqual(reason, [{ reason: "revoked" }]);
              const currentRunId = yield* runIdFor(candidate);
              const missing = yield* Effect.flip(engine.inspect(currentRunId));
              assert.strictEqual(missing._tag, "RunNotFoundError");
            }
            const checked = yield* Ref.get(rechecks);
            assert.deepStrictEqual(checked, [second.event.id]);
          }).pipe(Effect.provide(runtime));
        }),
      ),
  );

  it.live("preserves newer queued work when an older trigger re-check does not match", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const finishFirst = yield* Deferred.make<void>();
        const finishThird = yield* Deferred.make<void>();
        const checking = yield* Deferred.make<void>();
        const checked = yield* Deferred.make<TriggerRecheck>();
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
            recheck: (candidate) =>
              candidate.event.id === second.event.id
                ? Deferred.succeed(checking, undefined).pipe(
                    Effect.andThen(Deferred.await(checked)),
                  )
                : stillMatches(candidate),
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
          yield* Deferred.succeed(checked, TriggerRecheck.NoLongerMatches());

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
          // The first approval applies only to its own Run; the queued Event's Run waits for
          // approval before any Attempt.
          const secondRunId = yield* runIdFor(second);
          yield* engine.inspect(secondRunId).pipe(
            Effect.retry({
              while: (error) => error._tag === "RunNotFoundError",
              times: 500,
              schedule: Schedule.spaced("10 millis"),
            }),
          );
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
