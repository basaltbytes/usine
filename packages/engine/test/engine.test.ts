import { assert, describe, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import { AgentFailure, AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { StepResult } from "@usine/core/step/result";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { layer } from "../src/database/local-sqlite.ts";
import { InstanceDirectory } from "@usine/core/instance";
import { RunEngine } from "../src/engine/engine.ts";
import { LoopControl } from "../src/loop-control/loop-control.ts";
import { Submission } from "../src/engine/submission.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";
import { StepExecutor } from "../src/step-executor.ts";
import { runIdFor } from "../src/workflow/workflow.ts";

const stepResult = (message: string) => new StepResult({ message, facts: [] });
const testAgent = new Agent({
  name: AgentName.make("developer"),
  brain: new BrainSpec({
    harness: "claude",
    model: ModelId.make("claude-sonnet-4-6"),
    effort: "high",
  }),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Implement the task."),
});

type AttemptPlan = Effect.Effect<StepResult, AttemptFailure>;

const executorLayer = (plans: Ref.Ref<ReadonlyArray<AttemptPlan>>) =>
  Layer.succeed(StepExecutor)({
    interrupt: () => Effect.void,
    reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
    execute: () =>
      Ref.modify(plans, (remaining) => {
        const [next, ...rest] = remaining;
        return [next, rest] as const;
      }).pipe(
        Effect.flatMap(
          (plan) => plan ?? Effect.die("The test StepExecutor ran out of scripted attempts"),
        ),
      ),
  });

const submission = (options: {
  readonly number: number;
  readonly item?: string;
  readonly approval?: "none" | "required";
}) => {
  const second = String(options.number).padStart(2, "0");
  return new Submission({
    event: new Event({
      id: EventId.make(`event-${options.number}`),
      dedupKey: DedupKey.make(`loop/item/revision-${options.number}`),
      payload: { revision: options.number },
      receivedAt: DateTime.makeUnsafe(`2026-08-24T12:00:${second}Z`),
    }),
    itemKey: ItemKey.make(options.item ?? "item-1"),
    loop: LoopName.make("review"),
    step: StepName.make("run"),
    approval: options.approval ?? "none",
    repository: RepositoryName.make("basaltbytes/usine"),
    revision: RepositoryRevision.make(`revision-${options.number}`),
    task: AttemptTask.make(`Run test ${options.number}`),
    agent: testAgent,
    parentModel: Option.none(),
  });
};

const approvalEvent = (number: number) => {
  const second = String(number).padStart(2, "0");
  return new Event({
    id: EventId.make(`approval-${number}`),
    dedupKey: DedupKey.make(`approval/run-${number}`),
    payload: { approved: true },
    receivedAt: DateTime.makeUnsafe(`2026-08-24T13:00:${second}Z`),
  });
};

const waitFor = Effect.fn("test.waitFor")(function* (
  engine: RunEngine["Service"],
  runId: RunId,
  predicate: (snapshot: Effect.Success<ReturnType<RunEngine["Service"]["inspect"]>>) => boolean,
) {
  let latest = yield* engine.inspect(runId);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate(latest)) return latest;
    yield* Effect.sleep("10 millis");
    latest = yield* engine.inspect(runId);
  }
  return yield* Effect.die(
    `Run ${runId} did not reach the expected state (state=${latest.run.state._tag}, attempts=${latest.attempts.map((attempt) => Option.match(attempt.outcome, { onNone: () => "open", onSome: (outcome) => outcome._tag })).join(",")})`,
  );
});

const withInstance = <A, E, R>(use: (directory: InstanceDirectory) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-engine-" }),
    );
    return yield* use(directory);
  }).pipe(Effect.provide(NodeServices.layer));

describe("durable run engine", () => {
  it.live("projects an Event through a successful Attempt", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("finished")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission({ number: 1 }));
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;

          const snapshot = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(snapshot.run.state._tag, "Succeeded");
          assert(Option.isSome(snapshot.step.result));
          assert.strictEqual(snapshot.step.result.value.message, "finished");
          assert.strictEqual(snapshot.attempts.length, 1);
          const attempt = snapshot.attempts[0];
          assert(
            attempt !== undefined &&
              Option.isSome(attempt.outcome) &&
              attempt.outcome.value._tag === "Succeeded",
          );
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("lists every Run newest first for operator read models", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("listed result")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const reader = yield* RunReader;
          const controls = yield* LoopControl;
          const initialRevision = Option.getOrThrow(yield* reader.revision());
          const first = yield* engine.submit(
            submission({ number: 1, item: "listed-one", approval: "required" }),
          );
          const second = yield* engine.submit(submission({ number: 2, item: "listed-two" }));
          assert.strictEqual(first._tag, "Claimed");
          assert.strictEqual(second._tag, "Claimed");
          if (first._tag !== "Claimed" || second._tag !== "Claimed") return;
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Waiting");
          yield* waitFor(engine, second.runId, ({ run }) => run.state._tag === "Succeeded");

          const listed = yield* reader.list({ closedLimit: 100 });
          assert.deepStrictEqual(
            listed.map(({ run }) => run.id),
            [second.runId, first.runId],
          );
          assert.strictEqual(listed[0]?.attempts.length, 1);
          assert.strictEqual(
            Option.getOrUndefined(listed[0]?.step.result ?? Option.none())?.message,
            "listed result",
          );
          // The closed window bounds settled history, but an open Run, here the
          // older Waiting one, must never fall out of the operator's view.
          const bounded = yield* reader.list({ closedLimit: 0 });
          assert.deepStrictEqual(
            bounded.map(({ run }) => run.id),
            [first.runId],
          );
          const runRevision = Option.getOrThrow(yield* reader.revision());
          assert(runRevision > initialRevision);
          yield* controls.pause(LoopName.make("review"));
          assert(Option.getOrThrow(yield* reader.revision()) > runRevision);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("deduplicates permanently and opens an approval gate only once", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("approved result")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const event = submission({ number: 2, approval: "required" });
          const first = yield* engine.submit(event);
          const duplicate = yield* engine.submit(event);
          assert.strictEqual(first._tag, "Claimed");
          assert.strictEqual(duplicate._tag, "Claimed");
          if (first._tag !== "Claimed" || duplicate._tag !== "Claimed") return;
          assert.strictEqual(duplicate.runId, first.runId);

          const waiting = yield* waitFor(
            engine,
            first.runId,
            ({ run }) => run.state._tag === "Waiting",
          );
          assert.strictEqual(waiting.attempts.length, 0);

          const approval = approvalEvent(2);
          yield* engine.approve(first.runId, approval);
          const finished = yield* waitFor(
            engine,
            first.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 1);

          // Re-delivery of the same approval Event is an idempotent join.
          yield* engine.approve(first.runId, approval);
          assert.strictEqual((yield* engine.inspect(first.runId)).attempts.length, 1);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("auto-retries only typed infrastructure failures", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const infrastructureFailure = new InfraFailure({
          message: "worker unreachable",
          cause: new Error("ECONNREFUSED"),
        });
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          infrastructureFailure,
          Effect.succeed(stepResult("retried")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission({ number: 3 }));
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;
          const finished = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 2);
          const firstOutcome = finished.attempts[0]?.outcome;
          assert(firstOutcome !== undefined);
          assert(Option.isSome(firstOutcome));
          assert.strictEqual(firstOutcome.value._tag, "Failed");
          if (firstOutcome.value._tag === "Failed") {
            assert.strictEqual(firstOutcome.value.failure._tag, "InfraFailure");
          }
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("translates an executor defect into a typed infrastructure failure", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.die(new Error("the executor adapter crashed")),
          Effect.succeed(stepResult("recovered")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(
            submission({ number: 13, item: "executor-defect" }),
          );
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;

          // Without the translation the defect suspends the workflow and the run
          // stays Running forever with an open Attempt; with it, the crash is
          // an InfraFailure that auto-retries.
          const finished = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 2);
          const crashed = finished.attempts[0]?.outcome;
          assert(crashed !== undefined);
          assert(Option.isSome(crashed));
          assert.strictEqual(crashed.value._tag, "Failed");
          if (crashed.value._tag === "Failed") {
            assert.strictEqual(crashed.value.failure._tag, "InfraFailure");
          }
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("stops automatic infrastructure retry at three Attempts", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const failure = new InfraFailure({
          message: "worker unavailable",
          cause: new Error("offline"),
        });
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          failure,
          failure,
          failure,
          Effect.succeed(stepResult("operator retry")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission({ number: 30, item: "retry-cap" }));
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;
          const capped = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Failed",
          );
          assert.strictEqual(capped.attempts.length, 3);

          yield* engine.retry(accepted.runId);
          const finished = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 4);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("parks an agent failure until the operator retries the same Step", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          new AgentFailure({ message: "agent could not finish" }),
          Effect.succeed(stepResult("operator-guided result")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission({ number: 4 }));
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;

          const failed = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Failed",
          );
          assert.strictEqual(failed.attempts.length, 1);
          yield* Effect.sleep("25 millis");
          assert.strictEqual((yield* engine.inspect(accepted.runId)).attempts.length, 1);

          // Retry as soon as the projection is Failed, while the workflow may still be suspending.
          yield* engine.retry(accepted.runId);
          const finished = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 2);
          assert.strictEqual(finished.attempts[1]?.number, 2);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("supersedes and revokes only runs whose Attempt has not started", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const first = yield* engine.submit(submission({ number: 5, approval: "required" }));
          assert.strictEqual(first._tag, "Claimed");
          if (first._tag !== "Claimed") return;
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Waiting");

          const second = yield* engine.submit(submission({ number: 6, approval: "required" }));
          assert.strictEqual(second._tag, "Claimed");
          if (second._tag !== "Claimed") return;
          const superseded = yield* engine.inspect(first.runId);
          assert.strictEqual(superseded.run.state._tag, "Canceled");
          if (
            superseded.run.state._tag === "Canceled" &&
            superseded.run.state.reason._tag === "Superseded"
          ) {
            assert.strictEqual(superseded.run.state.reason.by, second.eventId);
          } else {
            assert.fail("the first run did not record its superseding Event");
          }

          yield* waitFor(engine, second.runId, ({ run }) => run.state._tag === "Waiting");
          yield* engine.revoke(LoopName.make("review"), ItemKey.make("item-1"));
          const revoked = yield* engine.inspect(second.runId);
          assert.strictEqual(revoked.run.state._tag, "Canceled");
          if (revoked.run.state._tag === "Canceled") {
            assert.strictEqual(revoked.run.state.reason._tag, "Revoked");
          }
          assert.strictEqual(revoked.attempts.length, 0);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("lets a running Attempt finish before opening the newest Event", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(gate).pipe(Effect.as(stepResult("first result"))),
          Effect.succeed(stepResult("newest result")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const first = yield* engine.submit(submission({ number: 7 }));
          assert.strictEqual(first._tag, "Claimed");
          if (first._tag !== "Claimed") return;
          yield* waitFor(
            engine,
            first.runId,
            ({ run, attempts }) => run.state._tag === "Running" && attempts.length === 1,
          );
          const retryRejected = yield* Effect.flip(engine.retry(first.runId));
          assert.strictEqual(retryRejected._tag, "RunOperationRejectedError");

          const newestEvent = submission({ number: 8 });
          const queued = yield* engine.submit(newestEvent);
          assert.strictEqual(queued._tag, "Queued");
          const supersedingEvent = submission({ number: 10 });
          assert.strictEqual((yield* engine.submit(supersedingEvent))._tag, "Queued");
          assert.strictEqual((yield* engine.inspect(first.runId)).run.state._tag, "Running");

          yield* Deferred.succeed(gate, undefined);
          yield* waitFor(engine, first.runId, ({ run }) => run.state._tag === "Succeeded");
          const reconsidered = yield* engine.submit(supersedingEvent);
          assert.strictEqual(reconsidered._tag, "Claimed");
          if (reconsidered._tag !== "Claimed") return;
          const newest = yield* waitFor(
            engine,
            reconsidered.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert(Option.isSome(newest.step.result));
          assert.strictEqual(newest.step.result.value.message, "newest result");
          const stale = yield* engine.submit(newestEvent);
          assert.strictEqual(stale._tag, "Ignored");
          if (stale._tag === "Ignored") {
            assert.strictEqual(stale.reason, "superseded");
          }
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("records operator cancellation of a running Attempt atomically", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([Effect.never]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission({ number: 11, item: "cancel-running" }));
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;
          yield* waitFor(engine, accepted.runId, ({ run }) => run.state._tag === "Running");

          yield* engine.cancel(accepted.runId);
          yield* engine.cancel(accepted.runId);
          const canceled = yield* engine.inspect(accepted.runId);
          assert.strictEqual(canceled.run.state._tag, "Canceled");
          assert.strictEqual(canceled.attempts.length, 1);
          const outcome = canceled.attempts[0]?.outcome;
          assert(outcome !== undefined);
          assert(Option.isSome(outcome));
          assert.strictEqual(outcome.value._tag, "Canceled");
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("keeps an approval wait parked when the runtime restarts", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("approved after restart")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        const firstScope = yield* Scope.make();
        const firstContext = yield* Scope.provide(Layer.build(runtime), firstScope);
        const firstEngine = Context.get(firstContext, RunEngine);
        const accepted = yield* firstEngine.submit(
          submission({ number: 12, item: "approval-restart", approval: "required" }),
        );
        assert.strictEqual(accepted._tag, "Claimed");
        if (accepted._tag !== "Claimed") return;
        yield* waitFor(firstEngine, accepted.runId, ({ run }) => run.state._tag === "Waiting");
        yield* Scope.close(firstScope, Exit.void);

        const secondScope = yield* Scope.make();
        const secondContext = yield* Scope.provide(Layer.build(runtime), secondScope);
        const secondEngine = Context.get(secondContext, RunEngine);
        yield* Effect.sleep("25 millis");
        const parked = yield* secondEngine.inspect(accepted.runId);
        assert.strictEqual(parked.run.state._tag, "Waiting");
        assert.strictEqual(parked.attempts.length, 0);

        yield* secondEngine.approve(accepted.runId, approvalEvent(12));
        const finished = yield* waitFor(
          secondEngine,
          accepted.runId,
          ({ run }) => run.state._tag === "Succeeded",
        );
        assert.strictEqual(finished.attempts.length, 1);
        yield* Scope.close(secondScope, Exit.void);
      }),
    ),
  );

  it.live("repairs an in-flight Attempt as N+1 after the runtime restarts", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.never,
          Effect.succeed(stepResult("resumed after restart")),
        ]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));

        const firstScope = yield* Scope.make();
        const firstContext = yield* Scope.provide(Layer.build(runtime), firstScope);
        const firstEngine = Context.get(firstContext, RunEngine);
        const accepted = yield* firstEngine.submit(submission({ number: 9 }));
        assert.strictEqual(accepted._tag, "Claimed");
        if (accepted._tag !== "Claimed") return;
        yield* waitFor(
          firstEngine,
          accepted.runId,
          ({ run, attempts }) => run.state._tag === "Running" && attempts.length === 1,
        );
        yield* Scope.close(firstScope, Exit.void);

        const secondScope = yield* Scope.make();
        const secondContext = yield* Scope.provide(Layer.build(runtime), secondScope);
        const secondEngine = Context.get(secondContext, RunEngine);
        const repaired = yield* waitFor(
          secondEngine,
          accepted.runId,
          ({ run }) => run.state._tag === "Succeeded",
        );
        assert.strictEqual(repaired.attempts.length, 2);
        assert.strictEqual(repaired.attempts[1]?.number, 2);
        const interrupted = repaired.attempts[0]?.outcome;
        assert(interrupted !== undefined);
        assert(Option.isSome(interrupted));
        assert.strictEqual(interrupted.value._tag, "Failed");
        if (interrupted.value._tag === "Failed") {
          assert.strictEqual(interrupted.value.failure._tag, "InfraFailure");
        }
        yield* Scope.close(secondScope, Exit.void);
      }),
    ),
  );

  it.live("drains an admitted Attempt and leaves queued and new work for restart", () =>
    withInstance((directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as(stepResult("finished before shutdown")),
            ),
            Effect.succeed(stepResult("queued work after restart")),
            Effect.succeed(stepResult("new work after restart")),
          ]);
          const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));
          const firstScope = yield* Scope.make();
          const first = Context.get(
            yield* Scope.provide(Layer.build(runtime), firstScope),
            RunEngine,
          );
          const accepted = yield* first.submit(submission({ number: 42 }));
          assert(accepted._tag === "Claimed");
          yield* Deferred.await(started);
          const queued = submission({ number: 43 });
          assert.strictEqual((yield* first.submit(queued))._tag, "Queued");
          const draining = yield* Effect.forkScoped(first.drain(), { startImmediately: true });
          const next = submission({ number: 44, item: "another-item" });
          yield* first.submit(next);
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(draining);
          const completed = yield* first.inspect(accepted.runId);
          assert.strictEqual(completed.run.state._tag, "Succeeded");
          assert.strictEqual(completed.attempts.length, 1);
          assert.strictEqual((yield* Ref.get(plans)).length, 2);
          yield* Scope.close(firstScope, Exit.void);

          const secondScope = yield* Scope.make();
          const second = Context.get(
            yield* Scope.provide(Layer.build(runtime), secondScope),
            RunEngine,
          );
          for (const pending of [queued, next]) {
            const completed = yield* waitFor(
              second,
              yield* runIdFor(pending),
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.strictEqual(completed.attempts.length, 1);
          }
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
    ),
  );

  it.live("defers an automatic retry during drain without adding an interruption failure", () =>
    withInstance((directory) =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.andThen(
                new InfraFailure({ message: "temporary worker failure", cause: "test" }),
              ),
            ),
            Effect.succeed(stepResult("retried after restart")),
          ]);
          const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));
          const firstScope = yield* Scope.make();
          const first = Context.get(
            yield* Scope.provide(Layer.build(runtime), firstScope),
            RunEngine,
          );
          const accepted = yield* first.submit(submission({ number: 45 }));
          assert(accepted._tag === "Claimed");
          yield* Deferred.await(started);
          const draining = yield* Effect.forkScoped(first.drain(), { startImmediately: true });
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(draining);
          assert.strictEqual((yield* first.inspect(accepted.runId)).attempts.length, 1);
          assert.strictEqual((yield* Ref.get(plans)).length, 1);
          yield* Scope.close(firstScope, Exit.void);
          const secondScope = yield* Scope.make();
          const second = Context.get(
            yield* Scope.provide(Layer.build(runtime), secondScope),
            RunEngine,
          );
          const completed = yield* waitFor(
            second,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(completed.attempts.length, 2);
          const outcome = completed.attempts[0]?.outcome;
          assert(
            outcome !== undefined && Option.isSome(outcome) && outcome.value._tag === "Failed",
          );
          assert(outcome.value.failure._tag === "InfraFailure");
          assert.strictEqual(outcome.value.failure.message, "temporary worker failure");
          yield* Scope.close(secondScope, Exit.void);
        }),
      ),
    ),
  );

  it.live("co-locates usine and cluster tables in the instance database", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
        const runtime = layer(directory).pipe(Layer.provide(executorLayer(plans)));
        const path = yield* Path.Path;
        const database = path.join(directory, ".usine", "runtime.sqlite");

        yield* Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          assert.strictEqual(yield* fileSystem.exists(database), true);
          const tableRows = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql`
              SELECT name
              FROM sqlite_master
              WHERE type = 'table'
              ORDER BY name
            `;
            return yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ name: Schema.String })),
            )(rows);
          }).pipe(Effect.provide(SqliteClient.layer({ filename: database })));
          const tables = tableRows.map(({ name }) => name);
          assert.includeMembers(tables, [
            "cluster_messages",
            "cluster_migrations",
            "cluster_replies",
            "usine_attempts",
            "usine_events",
            "usine_migrations",
            "usine_runs",
            "usine_steps",
            "usine_workflow_commands",
          ]);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("cancels a run parked in the worker queue without starting an attempt", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const reserveEntered = yield* Deferred.make<void>();
        // A 0-capacity scheduler parks the run in `reserve` forever; only a
        // cancel that reaches the parked reservation ends it.
        const executor = Layer.succeed(StepExecutor)({
          interrupt: () => Effect.void,
          reserve: () =>
            Deferred.succeed(reserveEntered, undefined).pipe(Effect.andThen(Effect.never)),
          execute: () => Effect.die("a canceled queued run must not execute"),
        });
        const runtime = layer(directory).pipe(Layer.provide(executor));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const result = yield* engine.submit(submission({ number: 41 }));
          assert(result._tag === "Claimed");
          if (result._tag !== "Claimed") return;
          yield* Deferred.await(reserveEntered);
          yield* engine.cancel(result.runId);
          const snapshot = yield* waitFor(
            engine,
            result.runId,
            ({ run }) => run.state._tag === "Canceled",
          );
          assert.strictEqual(snapshot.attempts.length, 0);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );
});
