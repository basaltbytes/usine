import { Intervention, OperatorMessage, ParentTarget } from "@usine/core/attempt/channel";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptContext, AttemptId, AttemptTask } from "@usine/core/attempt";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import {
  StartedByEditAndRetry,
  StartedByEvent,
  StartedByInfraRetry,
  StartedByRetry,
} from "@usine/core/attempt/start";
import { Event, EventId } from "@usine/core/event";
import type { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import type { RunId } from "@usine/core/run";
import { ApprovalSource, RunApproval } from "@usine/core/run/approval";
import { WorkerName } from "@usine/core/worker";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Ref,
  Schedule,
  Tracer,
  TxRef,
} from "effect";
import { RunDatabase, type RunDatabaseClient } from "../src/database/database.ts";
import { localSqliteLayer } from "../src/database/local-sqlite.ts";
import {
  layerWithDatabase,
  LeftoversDiscardRejectedError,
  ReconcileInterval,
  RetryRequest,
  RunEngine,
  UnconfirmedStop,
  UnconfirmedStops,
} from "../src/engine/engine.ts";
import { LoopControl } from "../src/loop-control/loop-control.ts";
import { RunReader } from "../src/run-reader/run-reader.ts";
import { StepExecutor } from "../src/step-executor.ts";
import type { TriggerRecheck } from "../src/trigger-condition.ts";
import { runIdFor, Submission } from "../src/engine/submission.ts";
import {
  approvalEvent,
  uiApproval,
  type AttemptPlan,
  conditionLayer,
  engineLayer,
  executorLayer,
  slottedExecutor,
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
            workers: Effect.succeed([WorkerName.make("local")]),
            isLive: () => Effect.succeed(false),
            outcome: () => Effect.succeed(Option.none()),
            recover: () => Effect.void,
            intervene: () => Effect.void,
            interrupt: () => Effect.void,
            occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
            sweep: Effect.void,
            discard: () => Effect.void,
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
            yield* engine.retry(
              accepted.runId,
              new RetryRequest({
                requestedBy: Option.some(OperatorLogin.make("PhilDL")),
                amendment: Option.some(amended),
              }),
            );
            const finished = yield* waitFor(
              engine,
              accepted.runId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.strictEqual(executed.length, 3);
            assert.deepStrictEqual(
              finished.attempts.map(({ start }) => start),
              [
                Option.some(new StartedByEvent()),
                Option.some(
                  new StartedByEditAndRetry({
                    operator: Option.some(OperatorLogin.make("PhilDL")),
                  }),
                ),
                Option.some(new StartedByInfraRetry()),
              ],
            );
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
          workers: Effect.succeed([WorkerName.make("local")]),
          isLive: () => Effect.succeed(false),
          outcome: () => Effect.succeed(Option.none()),
          recover: () => Effect.void,
          occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
          sweep: Effect.void,
          discard: () => Effect.void,
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

  it.live("drives each Run in its own trace, linked to the span that launched it", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("finished")),
        ]);
        const native = yield* Tracer.Tracer;
        const spans: Array<Tracer.Span> = [];
        const recording = Tracer.make({
          span: (options) => {
            const span = native.span(options);
            spans.push(span);
            return span;
          },
        });

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine
            .submit(submission({ number: 1 }))
            .pipe(Effect.withSpan("Test.pollCycle"));
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;
          yield* waitFor(engine, accepted.runId, ({ run }) => run.state._tag === "Succeeded");
        }).pipe(
          Effect.provide(engineLayer(directory, executorLayer(plans))),
          Effect.withTracer(recording),
        );

        const named = (name: string) => spans.find((span) => span.name === name);
        const poll = named("Test.pollCycle");
        const launch = named("RunDriver.launch");
        const drive = named("RunDriver.drive");
        const attempt = named("RunDriver.attempt");
        assert(poll && launch && drive && attempt);
        assert.strictEqual(launch.traceId, poll.traceId);
        assert(Option.isNone(drive.parent));
        assert.notStrictEqual(drive.traceId, poll.traceId);
        assert.lengthOf(drive.links, 1);
        assert.strictEqual(drive.links[0]?.span, launch);
        assert.strictEqual(attempt.traceId, drive.traceId);
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
          // `closedLimit` bounds closed Runs only, so the older waiting Run is still listed.
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

  it.live(
    "deduplicates permanently and opens an approval gate only once, recording its source",
    () =>
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
            assert(Option.isNone(waiting.approval));

            const approval = approvalEvent(2);
            const askAnswer = new ApprovalSource({
              channel: "github-ask",
              approver: Option.some(OperatorLogin.make("Philippe")),
            });
            yield* engine.approve(first.runId, approval, askAnswer);
            const finished = yield* waitFor(
              engine,
              first.runId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.strictEqual(finished.attempts.length, 1);
            const recorded = Option.some(
              new RunApproval({ approvedAt: approval.receivedAt, source: Option.some(askAnswer) }),
            );
            assert.deepStrictEqual(finished.approval, recorded);

            // Redelivering the same approval Event changes nothing, and a later approval from
            // another channel doesn't change the approver.
            yield* engine.approve(first.runId, approval, uiApproval);
            const rejoined = yield* engine.inspect(first.runId);
            assert.strictEqual(rejoined.attempts.length, 1);
            assert.deepStrictEqual(rejoined.approval, recorded);
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

          // A defect neither leaves an Attempt open nor retries agent work automatically.
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
          assert.deepStrictEqual(
            finished.attempts.map(({ start }) => Option.map(start, ({ _tag }) => _tag)),
            ["Event", "InfraRetry", "InfraRetry", "OperatorRetry"].map(Option.some),
          );
          assert.deepStrictEqual(
            finished.attempts[3]?.start,
            Option.some(new StartedByRetry({ operator: Option.none() })),
          );
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
        const answer = yield* Deferred.make<TriggerRecheck>();
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
          yield* Deferred.succeed(answer, "no-longer-matches");
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

  it.live("counts the Attempts a Worker still runs and refuses to discard their leftovers", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const plans = yield* Ref.make<ReadonlyArray<AttemptPlan>>([
          Effect.succeed(stepResult("ended on local")),
          Effect.never,
        ]);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const reader = yield* RunReader;
          const ended = yield* engine.submit(submission({ number: 12, item: "ended-on-local" }));
          assert(ended._tag === "Claimed");
          yield* waitFor(engine, ended.runId, ({ run }) => run.state._tag === "Succeeded");
          const running = yield* engine.submit(submission({ number: 13, item: "runs-on-local" }));
          assert(running._tag === "Claimed");
          yield* waitFor(engine, running.runId, ({ attempts }) => attempts.length === 1);

          const counts = Effect.map(reader.attemptsByWorker(), (counted) =>
            counted.map(({ worker, attempts, running }) => [worker, attempts, running]),
          );
          assert.deepStrictEqual(yield* counts, [["local", 2, 1]]);
          // `local` is in `StepExecutor.workers`, like a removed Worker until its last Attempt ends.
          const local = WorkerName.make("local");
          assert.deepStrictEqual(
            yield* Effect.flip(engine.discardLeftovers(local)),
            new LeftoversDiscardRejectedError({ worker: local, running: 1 }),
          );
          assert.deepStrictEqual(yield* counts, [["local", 2, 1]]);
        }).pipe(Effect.provide(engineLayer(directory, executorLayer(plans))));
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
          Ref.update(checks, (count) => count + 1).pipe(Effect.as("matches" as const)),
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

  it.live(
    "keeps the slot of a canceled Attempt whose parent task can't be stopped until a retried stop succeeds",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const local = WorkerName.make("local");
          const unstoppable = submission({ number: 42, item: "unstoppable-parent" });
          const behind = submission({ number: 43, item: "waits-for-the-slot" });
          // `local` has one slot, counted as the scheduler counts it.
          const leased = yield* TxRef.make(0);
          const refusing = yield* Ref.make(true);
          const stops = yield* Ref.make(0);
          const stopRequested = yield* Deferred.make<void>();
          const executor = Layer.succeed(StepExecutor)({
            workers: Effect.succeed([local]),
            isLive: () => Effect.succeed(false),
            outcome: () => Effect.succeed(Option.none()),
            recover: () => Effect.void,
            intervene: () => Effect.void,
            // Like the durable session, a stop ends the execution within the interrupt grace even
            // if the parent task's cancel fails.
            interrupt: () =>
              Effect.gen(function* () {
                yield* Ref.update(stops, (count) => count + 1);
                yield* Deferred.succeed(stopRequested, undefined);
                yield* Effect.sleep("20 millis");
                if (yield* Ref.get(refusing))
                  return yield* new InfraFailure({
                    message: "Could not cancel the parent task",
                    cause: "storage unavailable",
                  });
              }),
            occupy: () => Effect.die("no Attempt survives a restart in this test"),
            sweep: Effect.void,
            discard: () => Effect.void,
            reserve: () =>
              Effect.tx(
                Effect.gen(function* () {
                  if ((yield* TxRef.get(leased)) >= 1) return yield* Effect.txRetry;
                  yield* TxRef.update(leased, (count) => count + 1);
                }),
              ).pipe(
                Effect.as({ worker: local, release: TxRef.update(leased, (count) => count - 1) }),
              ),
            execute: (execution, io) =>
              Effect.gen(function* () {
                yield* io.checkoutAcquired;
                if (execution.task !== unstoppable.task) return stepResult("ran in the freed slot");
                yield* Deferred.await(stopRequested);
                return yield* new InfraFailure({
                  message: "The Attempt's execution stopped",
                  cause: "canceled",
                });
              }),
          });
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const unconfirmed = yield* UnconfirmedStops;
            const running = yield* engine.submit(unstoppable);
            assert(running._tag === "Claimed");
            const [attempt] = (yield* waitFor(
              engine,
              running.runId,
              ({ attempts }) => attempts.length === 1,
            )).attempts;
            assert(attempt !== undefined);
            const waiting = yield* engine.submit(behind);
            assert(waiting._tag === "Claimed");

            const refusal = yield* Effect.flip(engine.cancel(running.runId));
            assert.strictEqual(refusal._tag, "AttemptCancellationError");

            // The slot stays taken across the reconciles that retry the stop, so the Run behind
            // starts no Attempt.
            const [, { attempts }] = yield* Effect.repeat(
              Effect.all([Ref.get(stops), engine.inspect(waiting.runId)]),
              {
                until: ([count, { attempts }]) => count >= 4 || attempts.length > 0,
                schedule: Schedule.spaced("10 millis"),
              },
            );
            assert.deepStrictEqual(attempts, []);
            assert.strictEqual(yield* TxRef.get(leased), 1);
            // The canceled execution also fails, so either stop can record the Attempt first.
            const listed = yield* unconfirmed.list;
            assert.deepStrictEqual(
              listed.map(({ reason: _reason, ...stop }) => stop),
              [
                {
                  attemptId: attempt.id,
                  runId: running.runId,
                  loop: unstoppable.loop,
                  itemKey: unstoppable.itemKey,
                  worker: local,
                },
              ],
            );
            assert.include(["cancel", "failed"], listed[0]?.reason);

            // Once a retry stops the parent task, the slot is released and the Run behind takes it.
            yield* Ref.set(refusing, false);
            const delivered = yield* waitFor(
              engine,
              waiting.runId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.lengthOf(delivered.attempts, 1);
            assert.deepStrictEqual(yield* unconfirmed.list, []);
            yield* Effect.repeat(TxRef.get(leased), {
              until: (count) => count === 0,
              schedule: Schedule.spaced("10 millis"),
            }).pipe(Effect.timeout("2 seconds"));
          }).pipe(
            Effect.provide(engineLayer(directory, executor)),
            Effect.provideService(ReconcileInterval, "50 millis"),
          );
        }),
      ),
  );

  it.live.each([1, 2])(
    "keeps the slot of a failed Attempt whose parent task can't be stopped, and starts no retry on a Worker with %i slots, until a retried stop succeeds",
    (slots) =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const worker = yield* slottedExecutor(
            [
              Effect.fail(new InfraFailure({ message: "Lost the parent task", cause: "offline" })),
              Effect.succeed(stepResult("ran after the stop")),
            ],
            slots,
          );
          yield* Ref.set(worker.unstoppable, true);
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const unconfirmed = yield* UnconfirmedStops;
            const failing = submission({ number: 44, item: "unstoppable" });
            const accepted = yield* engine.submit(failing);
            assert(accepted._tag === "Claimed");

            // The Run's retry doesn't start, even in a free slot, across the reconciles that retry
            // the stop.
            const [stops, { attempts }] = yield* Effect.repeat(
              Effect.all([Ref.get(worker.stops), engine.inspect(accepted.runId)]),
              {
                until: ([stops, { attempts }]) => stops.length >= 4 || attempts.length > 1,
                schedule: Schedule.spaced("10 millis"),
              },
            );
            const [failed] = attempts;
            assert(failed !== undefined);
            assert.lengthOf(attempts, 1);
            assert.deepStrictEqual(
              Option.map(failed.outcome, ({ _tag }) => _tag),
              Option.some("Failed"),
            );
            assert.deepStrictEqual(new Set(stops.map(([, reason]) => reason)), new Set(["failed"]));
            assert.strictEqual(yield* TxRef.get(worker.leased), 1);
            assert.deepStrictEqual(yield* unconfirmed.list, [
              new UnconfirmedStop({
                attemptId: failed.id,
                runId: accepted.runId,
                loop: failing.loop,
                itemKey: failing.itemKey,
                worker: WorkerName.make("local"),
                reason: "failed",
              }),
            ]);

            // Once a retry stops the parent task, the slot is released and the retry takes it.
            yield* Ref.set(worker.unstoppable, false);
            const delivered = yield* waitFor(
              engine,
              accepted.runId,
              ({ run }) => run.state._tag === "Succeeded",
            );
            assert.lengthOf(delivered.attempts, 2);
            assert.deepStrictEqual(yield* unconfirmed.list, []);
            yield* Effect.repeat(TxRef.get(worker.leased), {
              until: (count) => count === 0,
              schedule: Schedule.spaced("10 millis"),
            }).pipe(Effect.timeout("2 seconds"));
          }).pipe(
            Effect.provide(engineLayer(directory, worker.executor)),
            Effect.provideService(ReconcileInterval, "50 millis"),
          );
        }),
      ),
  );

  it.live(
    "starts no Attempt on the Item of a canceled Attempt whose parent task can't be stopped, even in a free slot, until a retried stop succeeds",
    () =>
      withInstance((directory) =>
        Effect.gen(function* () {
          const local = WorkerName.make("local");
          const worker = yield* slottedExecutor(
            [
              Effect.never,
              Effect.succeed(stepResult("ran on another item")),
              Effect.succeed(stepResult("ran after the stop")),
            ],
            2,
          );
          yield* Effect.gen(function* () {
            const engine = yield* RunEngine;
            const unconfirmed = yield* UnconfirmedStops;
            const canceled = submission({ number: 46, item: "unstoppable-cancel" });
            const running = yield* engine.submit(canceled);
            assert(running._tag === "Claimed");
            const [attempt] = (yield* waitFor(
              engine,
              running.runId,
              ({ attempts }) => attempts.length === 1,
            )).attempts;
            assert(attempt !== undefined);
            const behind = submission({ number: 47, item: "unstoppable-cancel" });
            assert.strictEqual((yield* engine.submit(behind))._tag, "Queued");

            yield* Ref.set(worker.unstoppable, true);
            const refusal = yield* Effect.flip(engine.cancel(running.runId));
            assert.strictEqual(refusal._tag, "AttemptCancellationError");
            assert.deepStrictEqual(yield* unconfirmed.list, [
              new UnconfirmedStop({
                attemptId: attempt.id,
                runId: running.runId,
                loop: canceled.loop,
                itemKey: canceled.itemKey,
                worker: local,
                reason: "cancel",
              }),
            ]);

            // A Run on another Item takes the free slot.
            const other = yield* engine.submit(submission({ number: 48, item: "another-item" }));
            assert(other._tag === "Claimed");
            yield* waitFor(engine, other.runId, ({ run }) => run.state._tag === "Succeeded");

            // The queued Event's Run on the same Item starts no Attempt across the reconciles that
            // retry the stop.
            const queuedRunId = yield* runIdFor(behind);
            const [stops, waiting] = yield* Effect.repeat(
              Effect.all([Ref.get(worker.stops), engine.inspect(queuedRunId)]),
              {
                until: ([stops, { attempts }]) => stops.length >= 5 || attempts.length > 0,
                schedule: Schedule.spaced("10 millis"),
              },
            );
            assert.deepStrictEqual(waiting.attempts, []);
            assert.deepStrictEqual(new Set(stops.map(([, reason]) => reason)), new Set(["cancel"]));
            assert.strictEqual(yield* TxRef.get(worker.leased), 1);

            // Once a retry stops the parent task, the queued Event's Run starts.
            yield* Ref.set(worker.unstoppable, false);
            yield* waitFor(engine, queuedRunId, ({ run }) => run.state._tag === "Succeeded");
            assert.deepStrictEqual(yield* unconfirmed.list, []);
            yield* Effect.repeat(TxRef.get(worker.leased), {
              until: (count) => count === 0,
              schedule: Schedule.spaced("10 millis"),
            }).pipe(Effect.timeout("2 seconds"));
          }).pipe(
            Effect.provide(engineLayer(directory, worker.executor)),
            Effect.provideService(ReconcileInterval, "50 millis"),
          );
        }),
      ),
  );

  it.live("frees the slot of a failed Attempt at once when its parent task stops", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const worker = yield* slottedExecutor([
          Effect.fail(new InfraFailure({ message: "Lost the parent task", cause: "offline" })),
          Effect.succeed(stepResult("ran in the freed slot")),
        ]);
        // With the default reconcile interval, no reconcile runs during the test, so only the
        // freed slot lets the retry start.
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const unconfirmed = yield* UnconfirmedStops;
          const accepted = yield* engine.submit(submission({ number: 45, item: "stoppable" }));
          assert(accepted._tag === "Claimed");
          const delivered = yield* waitFor(
            engine,
            accepted.runId,
            ({ run }) => run.state._tag === "Succeeded",
          );
          const [failed] = delivered.attempts;
          assert(failed !== undefined);
          assert.lengthOf(delivered.attempts, 2);
          assert.deepStrictEqual(yield* Ref.get(worker.stops), [[failed.id, "failed"]]);
          assert.deepStrictEqual(yield* unconfirmed.list, []);
          yield* Effect.repeat(TxRef.get(worker.leased), {
            until: (count) => count === 0,
            schedule: Schedule.spaced("10 millis"),
          }).pipe(Effect.timeout("2 seconds"));
        }).pipe(Effect.provide(engineLayer(directory, worker.executor)));
      }),
    ),
  );

  it.live("cancels a run parked in the worker queue without starting an attempt", () =>
    withInstance((directory) =>
      Effect.gen(function* () {
        const reserveEntered = yield* Deferred.make<void>();
        const reserveLeft = yield* Deferred.make<void>();
        // With 0 capacity, the Run waits in `reserve` forever; only a cancel ends the wait.
        const executor = Layer.succeed(StepExecutor)({
          workers: Effect.succeed([WorkerName.make("local")]),
          isLive: () => Effect.succeed(false),
          outcome: () => Effect.succeed(Option.none()),
          recover: () => Effect.void,
          intervene: () => Effect.void,
          interrupt: () => Effect.void,
          occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
          sweep: Effect.void,
          discard: () => Effect.void,
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
          // The ID that earlier versions assigned to this Event, so existing Runs keep their IDs.
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
          const rejected = yield* Effect.flip(
            engine.approve(parked.runId, approvalEvent(50), uiApproval),
          );
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

/** The number of upcoming transactions that fail before they start. */
interface Failures {
  left: number;
}

/** Returns the instance's database, with transactions that fail while `failures.left` is positive. */
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

/** Returns the engine on `flakyDatabase` with `executor`; every queued Event's trigger still matches. */
const flakyEngineLayer = (
  directory: InstanceDirectory,
  failures: Failures,
  executor: Layer.Layer<StepExecutor>,
) =>
  layerWithDatabase(flakyDatabase(directory, failures)).pipe(
    Layer.provide(executor),
    Layer.provide(conditionLayer(Effect.succeed("matches"))),
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
              reserve: (runId: RunId, request: Submission, worker: Option.Option<WorkerName>) =>
                Ref.getAndUpdate(reserved, (count) => count + 1).pipe(
                  Effect.tap((count) =>
                    Effect.sync(() => {
                      if (count === 0) failures.left = Number.POSITIVE_INFINITY;
                    }),
                  ),
                  Effect.andThen(scripted.reserve(runId, request, worker)),
                ),
            });
          }),
        ).pipe(Layer.provide(executorLayer(plans)));
        const failureSpans: Array<string | undefined> = [];
        const recovering = Logger.make(({ message, fiber }) => {
          if (/fiber stopped on an engine failure/u.test(JSON.stringify(message))) {
            const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
            failureSpans.push(span?._tag === "Span" ? span.name : undefined);
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
          // The failure is an event of the Run's trace, not of the launch span that already ended.
          assert.deepStrictEqual(failureSpans, ["RunDriver.drive"]);
        }).pipe(
          Effect.provide(flakyEngineLayer(directory, failures, executor)),
          Effect.provideService(ReconcileInterval, "50 millis"),
          Effect.provide(Logger.layer([recovering])),
        );
      }),
    ),
  );
});
