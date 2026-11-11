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
        const rechecks = yield* Ref.make<ReadonlyArray<EventId>>([]);
        const runtime = engineLayer(
          directory,
          executorLayer(plans),
          Layer.succeed(TriggerCondition)({
            recheck: (candidate) =>
              Ref.update(rechecks, (all) => [...all, candidate.event.id]).pipe(
                Effect.andThen(
                  candidate.event.id === second.event.id
                    ? Deferred.succeed(checking, undefined).pipe(
                        Effect.andThen(Deferred.await(checked)),
                      )
                    : stillMatches(candidate),
                ),
              ),
          }),
        );
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

          // C's claim superseded B, so no write marks the end of B's continuation. With C open,
          // the continuation rechecks nothing after B's mismatch.
          yield* Effect.sleep("200 millis");
          const afterMismatch = yield* Ref.get(rechecks);
          assert.deepStrictEqual(afterMismatch, [second.event.id]);
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
          // C's close gives D its only recheck.
          const allRechecks = yield* Ref.get(rechecks);
          assert.deepStrictEqual(allRechecks, [second.event.id, fourth.event.id]);
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
  it.live("keeps a queued CI fix queued while its recheck is undetermined", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(gate).pipe(Effect.as(stepResult("first"))),
          Effect.succeed(stepResult("fixed")),
        ]);
        const rechecks = yield* Ref.make<ReadonlyArray<EventId>>([]);
        const runtime = engineLayer(
          directory,
          executorLayer(plans),
          conditionLayer((candidate) =>
            Ref.updateAndGet(rechecks, (all) => [...all, candidate.event.id]).pipe(
              Effect.flatMap((checked): Effect.Effect<TriggerRecheck> =>
                checked.length === 1
                  ? Effect.succeed(TriggerRecheck.Undetermined())
                  : stillMatches(candidate),
              ),
            ),
          ),
        );
        const path = yield* Path.Path;
        const database = path.join(directory, ".usine", "runtime.sqlite");
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const first = yield* engine.submit(submission({ number: 43 }));
          assert(first._tag === "Claimed");
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Running");
          const fix = Submission.make({
            ...submission({ number: 44 }),
            ciFailureHead: Option.some(CommitSha.make("a".repeat(40))),
          });
          assert.strictEqual((yield* engine.submit(fix))._tag, "Queued");

          yield* Deferred.succeed(gate, undefined);
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Succeeded");
          yield* Ref.get(rechecks).pipe(
            Effect.repeat({
              until: (checked) => checked.length === 1,
              schedule: Schedule.spaced("10 millis"),
              times: 500,
            }),
          );
          const fixRunId = yield* runIdFor(fix);
          const unopened = yield* Effect.flip(engine.inspect(fixRunId));
          assert.strictEqual(unopened._tag, "RunNotFoundError");
          const ignored = yield* ignoredReason(database, fix.event.id);
          assert.deepStrictEqual(ignored, []);

          yield* engine.reconcile;
          const fixed = yield* waitFor(
            engine,
            fixRunId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(fixed.attempts.length, 1);
          const checked = yield* Ref.get(rechecks);
          assert.deepStrictEqual(checked, [fix.event.id, fix.event.id]);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live(
    "opens a queued trigger match with its saved settings when its recheck is undetermined",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Deferred.await(gate).pipe(Effect.as(stepResult("first"))),
          ]);
          const runtime = engineLayer(
            directory,
            executorLayer(plans),
            conditionLayer(() => Effect.succeed(TriggerRecheck.Undetermined())),
          );
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const first = yield* engine.submit(submission({ number: 45 }));
            assert(first._tag === "Claimed");
            yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Running");
            const queued = submission({ number: 46, approval: "required" });
            assert.strictEqual((yield* engine.submit(queued))._tag, "Queued");

            yield* Deferred.succeed(gate, undefined);
            const queuedRunId = yield* runIdFor(queued);
            yield* engine.inspect(queuedRunId).pipe(
              Effect.retry({
                while: (error) => error._tag === "RunNotFoundError",
                times: 500,
                schedule: Schedule.spaced("10 millis"),
              }),
            );
            const parked = yield* waitFor(
              engine,
              queuedRunId,
              ({ run }) => run.state._tag === "Waiting",
            );
            assert.deepStrictEqual(parked.attempts, []);
          }).pipe(Effect.provide(runtime));
        }),
      ),
  );
  it.live("admits only the queued CI fixes, leaving a queued trigger match on another Item", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const fixGate = yield* Deferred.make<void>();
        const triggerGate = yield* Deferred.make<void>();
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(fixGate).pipe(Effect.as(stepResult("blocks the fix"))),
          Deferred.await(triggerGate).pipe(Effect.as(stepResult("blocks the trigger match"))),
          Effect.succeed(stepResult("fixed")),
          Effect.succeed(stepResult("triggered")),
        ]);
        const fix = Submission.make({
          ...submission({ number: 48, item: "item-fix" }),
          ciFailureHead: Option.some(CommitSha.make("b".repeat(40))),
        });
        const triggerMatch = submission({ number: 50, item: "item-trigger" });
        const rechecks = yield* Ref.make<ReadonlyArray<EventId>>([]);
        const triggerChecking = yield* Deferred.make<void>();
        const releaseTrigger = yield* Deferred.make<void>();
        const runtime = engineLayer(
          directory,
          executorLayer(plans),
          conditionLayer((candidate) =>
            Ref.updateAndGet(rechecks, (all) => [...all, candidate.event.id]).pipe(
              Effect.flatMap((checked): Effect.Effect<TriggerRecheck> => {
                const times = checked.filter((id) => id === candidate.event.id).length;
                if (candidate.event.id === fix.event.id && times === 1) {
                  return Effect.succeed(TriggerRecheck.Undetermined());
                }
                if (candidate.event.id === triggerMatch.event.id && times === 1) {
                  // The trigger match's own continuation holds here, so the queue stays
                  // admissible while `admitCiFixes` runs.
                  return Deferred.succeed(triggerChecking, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseTrigger)),
                    Effect.andThen(stillMatches(candidate)),
                  );
                }
                return stillMatches(candidate);
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const blockingFix = yield* engine.submit(submission({ number: 47, item: "item-fix" }));
          assert(blockingFix._tag === "Claimed");
          yield* waitFor(engine, blockingFix.runId, ({ run }) => run.state._tag === "Running");
          assert.strictEqual((yield* engine.submit(fix))._tag, "Queued");
          yield* Deferred.succeed(fixGate, undefined);
          yield* waitFor(engine, blockingFix.runId, ({ run }) => run.state._tag === "Succeeded");
          yield* Ref.get(rechecks).pipe(
            Effect.repeat({
              until: (checked) => checked.length === 1,
              schedule: Schedule.spaced("10 millis"),
              times: 500,
            }),
          );

          const blockingTrigger = yield* engine.submit(
            submission({ number: 49, item: "item-trigger" }),
          );
          assert(blockingTrigger._tag === "Claimed");
          yield* waitFor(engine, blockingTrigger.runId, ({ run }) => run.state._tag === "Running");
          assert.strictEqual((yield* engine.submit(triggerMatch))._tag, "Queued");
          yield* Deferred.succeed(triggerGate, undefined);
          yield* waitFor(
            engine,
            blockingTrigger.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          yield* Deferred.await(triggerChecking);

          const fixRunId = yield* runIdFor(fix);
          const triggerRunId = yield* runIdFor(triggerMatch);
          const opened = yield* engine.admitCiFixes;
          assert.deepStrictEqual(opened, [fixRunId]);
          const checked = yield* Ref.get(rechecks);
          assert.deepStrictEqual(checked, [fix.event.id, triggerMatch.event.id, fix.event.id]);
          const unopened = yield* Effect.flip(engine.inspect(triggerRunId));
          assert.strictEqual(unopened._tag, "RunNotFoundError");
          yield* waitFor(engine, fixRunId, ({ run }) => run.state._tag === "Succeeded");

          yield* Deferred.succeed(releaseTrigger, undefined);
          yield* engine.inspect(triggerRunId).pipe(
            Effect.retry({
              while: (error) => error._tag === "RunNotFoundError",
              times: 500,
              schedule: Schedule.spaced("10 millis"),
            }),
          );
          yield* waitFor(engine, triggerRunId, ({ run }) => run.state._tag === "Succeeded");
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );
});
