import { Intervention, OperatorMessage, ParentTarget } from "@usine/core/attempt/channel";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptContext, AttemptId, AttemptTask } from "@usine/core/attempt";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import { Event, EventId } from "@usine/core/event";
import type { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { WorkerName } from "@usine/core/worker";
import { Deferred, Effect, Fiber, Layer, Logger, Option, Ref } from "effect";
import { RunDatabase, type RunDatabaseClient } from "../src/database/database.ts";
import { localSqliteLayer } from "../src/database/local-sqlite.ts";
import { layerWithDatabase, ReconcileInterval, RunEngine } from "../src/engine/engine.ts";
import { LoopControl } from "../src/loop-control/loop-control.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";
import { StepExecutor } from "../src/step-executor.ts";
import { runIdFor, Submission } from "../src/engine/submission.ts";
import {
  approvalEvent,
  type AttemptPlan,
  conditionLayer,
  engineLayer,
  executorLayer,
  stepResult,
  submission,
  testAgent,
  waitFor,
  withInstance,
} from "./support.ts";

describe("durable run engine", () => {
  it.live(
    "keeps amended task and Agent through an infrastructure retry and records each Attempt's actual context",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const executed: Array<{
            readonly task: string;
            readonly agent: Agent;
            readonly parentModel: Option.Option<ModelId>;
          }> = [];
          const amended = new AttemptContext({
            task: AttemptTask.make("Fix the reviewed edge case"),
            agent: new Agent({
              ...testAgent,
              name: AgentName.make("reviewer"),
              persona: AgentPersona.make("Review the amended task"),
              brain: new BrainSpec({
                harness: "codex",
                model: ModelId.make("gpt-5.6-terra"),
                effort: "medium",
              }),
            }),
            parentModel: Option.some(ModelId.make("openai/changed-parent")),
          });
          const executor = Layer.succeed(StepExecutor)({
            isLive: () => Effect.succeed(false),
            outcome: () => Effect.succeed(Option.none()),
            recover: () => Effect.void,
            intervene: () => Effect.void,
            interrupt: () => Effect.void,
            reserve: () =>
              Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
            execute: (execution) =>
              Effect.gen(function* () {
                executed.push({
                  task: execution.task,
                  agent: execution.agent,
                  parentModel: execution.parentModel,
                });
                if (executed.length === 1)
                  return yield* new AgentFailure({ message: "Needs a correction" });
                if (executed.length === 2)
                  return yield* new InfraFailure({
                    message: "Link lost",
                    cause: new Error("offline"),
                  });
                return stepResult("Amended work completed");
              }),
          });
          const runtime = engineLayer(directory, executor);
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const original = submission({ number: 1 });
            const accepted = yield* engine.submit(original);
            assert.strictEqual(accepted._tag, "Claimed");
            if (accepted._tag !== "Claimed") return;
            yield* waitFor(engine, accepted.runId, ({ run }) => run.state._tag === "Failed");
            yield* engine.retry(accepted.runId, Option.some(amended));
            const finished = yield* waitFor(
              engine,
              accepted.runId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.strictEqual(executed.length, 3);
            assert.deepStrictEqual(
              executed.slice(1),
              [amended, amended].map(({ task, agent, parentModel }) => ({
                task,
                agent,
                parentModel,
              })),
            );
            assert.deepStrictEqual(
              finished.attempts.map(({ task, agent }) => ({ task, agent })),
              [
                { task: original.task, agent: original.agent.name },
                { task: amended.task, agent: amended.agent.name },
                { task: amended.task, agent: amended.agent.name },
              ],
            );
            assert.deepStrictEqual(finished.event, original.event);
            assert.strictEqual(finished.task, amended.task);
          }).pipe(Effect.provide(runtime));
        }),
      ),
  );
  it.live("rejects stale session input without delivering it to a later or canceled Attempt", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const delivered: Array<AttemptId> = [];
        const started = yield* Deferred.make<void>();
        const executor = Layer.succeed(StepExecutor)({
          isLive: () => Effect.succeed(false),
          outcome: () => Effect.succeed(Option.none()),
          recover: () => Effect.void,
          reserve: () => Effect.succeed({ worker: WorkerName.make("local"), release: Effect.void }),
          execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          interrupt: () => Effect.void,
          intervene: (id) =>
            Effect.sync(() => {
              delivered.push(id);
            }),
        });
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission({ number: 34 }));
          assert(accepted._tag === "Claimed");
          yield* Deferred.await(started);
          const current = yield* engine.inspect(accepted.runId);
          const attempt = current.attempts[0];
          assert(attempt !== undefined);
          const input = new Intervention({
            operator: "Philippe",
            target: new ParentTarget(),
            action: new OperatorMessage({ message: "Continue" }),
          });
          const stale = yield* Effect.flip(
            engine.intervene(accepted.runId, AttemptId.make("old-attempt"), input),
          );
          assert.strictEqual(stale._tag, "RunInterventionRejectedError");
          assert.deepStrictEqual(delivered, []);
          yield* engine.intervene(accepted.runId, attempt.id, input);
          assert.deepStrictEqual(delivered, [attempt.id]);
          yield* engine.cancel(accepted.runId);
          const canceled = yield* Effect.flip(engine.intervene(accepted.runId, attempt.id, input));
          assert.strictEqual(canceled._tag, "RunInterventionRejectedError");
          assert.deepStrictEqual(delivered, [attempt.id]);
        }).pipe(Effect.provide(engineLayer(directory, executor)));
      }),
    ),
  );

  it.live("projects an Event through a successful Attempt", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("finished")),
        ]);
        const runtime = engineLayer(directory, executorLayer(plans));

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
        const runtime = engineLayer(directory, executorLayer(plans));

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
          const history = yield* reader.forItems([
            ...Array.from({ length: 120 }, (_, i) => ItemKey.make(`absent-${i}`)),
            ItemKey.make("listed-two"),
            ItemKey.make("listed-two"),
          ]);
          assert.deepStrictEqual(
            history.map(({ run }) => run.id),
            [second.runId],
          );
          assert.strictEqual(history[0]?.attempts.length, 1);
          assert.deepStrictEqual(yield* reader.forItems([]), []);
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
        const runtime = engineLayer(directory, executorLayer(plans));

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
        const runtime = engineLayer(directory, executorLayer(plans));

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

  it.live("persists executor defects without automatic retry and permits an operator retry", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.die(new Error("the executor adapter crashed")),
          Effect.succeed(stepResult("recovered")),
        ]);
        const runtime = engineLayer(directory, executorLayer(plans));

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(
            submission({ number: 13, item: "executor-defect" }),
          );
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;

          // A defect must neither strand an open Attempt nor repeat agent work automatically.
          const finished = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Failed",
          );
          assert.strictEqual(finished.attempts.length, 1);
          assert.strictEqual((yield* Ref.get(plans)).length, 1);
          const crashed = finished.attempts[0]?.outcome;
          assert(crashed !== undefined);
          assert(Option.isSome(crashed));
          assert.strictEqual(crashed.value._tag, "Failed");
          if (crashed.value._tag === "Failed") {
            assert.strictEqual(crashed.value.failure._tag, "DefectFailure");
            if (crashed.value.failure._tag === "DefectFailure") {
              assert(crashed.value.failure.cause instanceof Error);
              assert.strictEqual(
                crashed.value.failure.cause.message,
                "the executor adapter crashed",
              );
            }
          }
          yield* engine.retry(accepted.runId);
          const retried = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(retried.attempts.length, 2);
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
        const runtime = engineLayer(directory, executorLayer(plans));

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
        const runtime = engineLayer(directory, executorLayer(plans));

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

          // Retry as soon as the projection is Failed, while the Run's fiber may still be ending.
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

  it.live("starts a retry that lands while the failed Run's fiber still re-checks its Item", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const finish = yield* Deferred.make<void>();
        const checking = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<boolean>();
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(finish).pipe(
            Effect.andThen(new AgentFailure({ message: "needs the operator" })),
          ),
          Effect.succeed(stepResult("retried")),
        ]);
        const runtime = engineLayer(
          directory,
          executorLayer(plans),
          conditionLayer(
            Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(answer))),
          ),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const failing = yield* engine.submit(submission({ number: 56, item: "retry-race" }));
          assert(failing._tag === "Claimed");
          yield* waitFor(engine, failing.runId, ({ run }) => run.state._tag === "Running");
          const queued = yield* engine.submit(submission({ number: 57, item: "retry-race" }));
          assert.strictEqual(queued._tag, "Queued");
          yield* Deferred.succeed(finish, undefined);
          // The failed Run's fiber is still re-checking the queued Event's trigger.
          yield* Deferred.await(checking);
          const retrying = yield* Effect.forkChild(engine.retry(failing.runId), {
            startImmediately: true,
          });
          yield* Deferred.succeed(answer, false);
          yield* Fiber.join(retrying);
          const finished = yield* waitFor(
            engine,
            failing.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 2);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("supersedes and revokes only runs whose Attempt has not started", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([]);
        const runtime = engineLayer(directory, executorLayer(plans));

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
        const runtime = engineLayer(directory, executorLayer(plans));

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
        const runtime = engineLayer(directory, executorLayer(plans));

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

  it.live("cancels a running Run and gives the Event queued behind it one turn", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const stopped = yield* Deferred.make<void>();
        const checks = yield* Ref.make(0);
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Deferred.await(stopped).pipe(
            Effect.andThen(new InfraFailure({ message: "stopped by the operator", cause: "test" })),
          ),
          Effect.succeed(stepResult("queued Event")),
        ]);
        // Like a real Worker, the running Attempt returns once the cancel stops it.
        const executor = Layer.effect(
          StepExecutor,
          Effect.gen(function* () {
            const scripted = yield* StepExecutor;
            return { ...scripted, interrupt: () => Deferred.succeed(stopped, undefined) };
          }),
        ).pipe(Layer.provide(executorLayer(plans)));
        const condition = conditionLayer(
          Ref.update(checks, (count) => count + 1).pipe(Effect.as(true)),
        );
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const running = yield* engine.submit(submission({ number: 58, item: "cancel-queued" }));
          assert(running._tag === "Claimed");
          yield* waitFor(engine, running.runId, ({ run }) => run.state._tag === "Running");
          const behind = submission({ number: 59, item: "cancel-queued" });
          assert.strictEqual((yield* engine.submit(behind))._tag, "Queued");
          yield* engine.cancel(running.runId);
          const opened = yield* waitFor(
            engine,
            yield* runIdFor(behind),
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(opened.attempts.length, 1);
          assert.strictEqual((yield* engine.inspect(running.runId)).run.state._tag, "Canceled");
          assert.strictEqual(yield* Ref.get(checks), 1);
        }).pipe(Effect.provide(engineLayer(directory, executor, condition)));
      }),
    ),
  );

  it.live("cancels a run parked in the worker queue without starting an attempt", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const reserveEntered = yield* Deferred.make<void>();
        const reserveLeft = yield* Deferred.make<void>();
        // A 0-capacity scheduler parks the run in `reserve` forever; only a
        // cancel that reaches the parked reservation ends it.
        const executor = Layer.succeed(StepExecutor)({
          isLive: () => Effect.succeed(false),
          outcome: () => Effect.succeed(Option.none()),
          recover: () => Effect.void,
          intervene: () => Effect.void,
          interrupt: () => Effect.void,
          reserve: () =>
            Deferred.succeed(reserveEntered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(reserveLeft, undefined)),
            ),
          execute: () => Effect.die("a canceled queued run must not execute"),
        });
        const runtime = engineLayer(directory, executor);

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const result = yield* engine.submit(submission({ number: 41 }));
          assert(result._tag === "Claimed");
          if (result._tag !== "Claimed") return;
          yield* Deferred.await(reserveEntered);
          yield* engine.cancel(result.runId);
          // The cancel returns only after the Run's fiber left its reservation.
          assert.isTrue(yield* Deferred.isDone(reserveLeft));
          const snapshot = yield* engine.inspect(result.runId);
          assert.strictEqual(snapshot.run.state._tag, "Canceled");
          assert.strictEqual(snapshot.attempts.length, 0);
        }).pipe(Effect.provide(runtime));
      }),
    ),
  );

  it.live("names a Run by its Event's dedup key and joins a resubmission to it", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([Effect.never]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const original = submission({ number: 1 });
          const first = yield* engine.submit(original);
          assert(first._tag === "Claimed");
          // The id earlier versions gave this Event, so existing Runs keep theirs.
          assert.strictEqual(first.runId, "c33a338a9aaafa7490fa315fbf02a437");
          assert.strictEqual(yield* runIdFor(original), first.runId);
          const resubmitted = yield* engine.submit(
            new Submission({
              ...original,
              event: new Event({ ...original.event, id: EventId.make("event-1-seen-again") }),
            }),
          );
          assert(resubmitted._tag === "Claimed");
          assert.strictEqual(resubmitted.runId, first.runId);
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );

  it.live("cancels a Run parked for approval so a later approval cannot start it", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.die("a canceled Run must not execute"),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const parked = yield* engine.submit(
            submission({ number: 50, item: "cancel-waiting", approval: "required" }),
          );
          assert(parked._tag === "Claimed");
          yield* waitFor(engine, parked.runId, ({ run }) => run.state._tag === "Waiting");
          yield* engine.cancel(parked.runId);
          const rejected = yield* Effect.flip(engine.approve(parked.runId, approvalEvent(50)));
          assert.strictEqual(rejected._tag, "RunOperationRejectedError");
          const canceled = yield* engine.inspect(parked.runId);
          assert.strictEqual(canceled.run.state._tag, "Canceled");
          assert.strictEqual(canceled.attempts.length, 0);
          assert.strictEqual((yield* Ref.get(plans)).length, 1);
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
      }),
    ),
  );
});

/** How many of the database's next transactions fail before they start. */
interface Failures {
  left: number;
}

/** The instance's database, whose transactions fail while `failures` has some left, as on a transient SQLite error. */
const flakyDatabase = (directory: InstanceDirectory, failures: Failures) =>
  Layer.effect(
    RunDatabase,
    Effect.gen(function* () {
      const database = yield* RunDatabase;
      const transaction = (...args: Parameters<RunDatabaseClient["transaction"]>) =>
        Effect.suspend(() => {
          if (failures.left <= 0) return database.transaction(...args);
          failures.left -= 1;
          return Effect.fail(new Error("database is locked"));
        });
      return new Proxy(database, {
        get: (target, property) => {
          if (property === "transaction") return transaction;
          // SAFETY: the proxy only forwards members of the database client.
          const member = target[property as keyof RunDatabaseClient];
          return member instanceof Function ? member.bind(target) : member;
        },
      });
    }),
  ).pipe(Layer.provide(localSqliteLayer(directory)));

/** The engine on `flakyDatabase`, with `executor` and every queued Event's trigger holding. */
const flakyEngineLayer = (
  directory: InstanceDirectory,
  failures: Failures,
  executor: Layer.Layer<StepExecutor>,
) =>
  layerWithDatabase(flakyDatabase(directory, failures)).pipe(
    Layer.provide(executor),
    Layer.provide(conditionLayer(Effect.succeed(true))),
    Layer.provide(NodeServices.layer),
  );

describe("store failures in a Run's fiber", () => {
  it.live("records an Attempt's outcome once a failed write succeeds on retry", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const failures: Failures = { left: 0 };
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          // The next transaction, which records this Attempt's outcome, fails once.
          Effect.sync(() => {
            failures.left = 1;
          }).pipe(Effect.as(stepResult("recorded on the second try"))),
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission({ number: 1, item: "retry" }));
          assert(accepted._tag === "Claimed");
          const finished = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 1);
          assert.strictEqual(failures.left, 0);
        }).pipe(Effect.provide(flakyEngineLayer(directory, failures, executorLayer(plans))));
      }),
    ),
  );

  it.live("drives a Run again on the next reconcile after its fiber stopped", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const failures: Failures = { left: 0 };
        const reserved = yield* Ref.make(0);
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("driven after the reconcile")),
        ]);
        // From the first reservation on, writes fail until the fiber gives up.
        const executor = Layer.effect(
          StepExecutor,
          Effect.gen(function* () {
            const scripted = yield* StepExecutor;
            return StepExecutor.of({
              ...scripted,
              reserve: (request: Submission) =>
                Ref.getAndUpdate(reserved, (count) => count + 1).pipe(
                  Effect.tap((count) =>
                    Effect.sync(() => {
                      if (count === 0) failures.left = Number.POSITIVE_INFINITY;
                    }),
                  ),
                  Effect.andThen(scripted.reserve(request)),
                ),
            });
          }),
        ).pipe(Layer.provide(executorLayer(plans)));
        const recovering = Logger.make(({ message }) => {
          if (/fiber stopped on an engine failure/u.test(JSON.stringify(message))) {
            failures.left = 0;
          }
        });
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission({ number: 2, item: "reconcile" }));
          assert(accepted._tag === "Claimed");
          const finished = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          assert.strictEqual(finished.attempts.length, 1);
          assert.strictEqual(yield* Ref.get(reserved), 2);
        }).pipe(
          Effect.provide(flakyEngineLayer(directory, failures, executor)),
          Effect.provideService(ReconcileInterval, "50 millis"),
          Effect.provide(Logger.layer([recovering])),
        );
      }),
    ),
  );
});
