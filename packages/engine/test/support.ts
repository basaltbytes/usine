import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { NodeServices } from "@effect/platform-node";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { type AttemptId, AttemptTask, type StopReason } from "@usine/core/attempt";
import { type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { OperatorLogin } from "@usine/core/operator";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { ApprovalSource } from "@usine/core/run/approval";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, FileSystem, Layer, Option, Ref, TxRef } from "effect";
import { layer, localSqliteLayer } from "../src/database/local-sqlite.ts";
import type { RunEngine } from "../src/engine/engine.ts";
import { Submission } from "../src/engine/submission.ts";
import { StepExecutor } from "../src/step-executor.ts";
import { RunStore } from "../src/store/store.ts";
import { TriggerCondition, type TriggerRecheck } from "../src/trigger-condition.ts";

export const stepResult = (message: string) => new StepResult({ message, facts: [] });
export const testAgent = new Agent({
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

export type AttemptPlan = Effect.Effect<StepResult, AttemptFailure>;

/** Returns a `TriggerCondition` layer that gives every queued Event the same answer. */
export const conditionLayer = (recheck: Effect.Effect<TriggerRecheck>) =>
  Layer.succeed(TriggerCondition)({ recheck: () => recheck });

/**
 * Returns the local engine over a scripted `StepExecutor`. Queued Events still match unless the
 * test provides a `TriggerCondition`.
 */
export const engineLayer = (
  directory: InstanceDirectory,
  executor: Layer.Layer<StepExecutor>,
  condition: Layer.Layer<TriggerCondition> = conditionLayer(Effect.succeed("matches")),
) => layer(directory).pipe(Layer.provide(executor), Layer.provide(condition));

export const executorLayer = (plans: Ref.Ref<ReadonlyArray<AttemptPlan>>) =>
  Layer.succeed(StepExecutor)({
    workers: Effect.succeed([WorkerName.make("local")]),
    isLive: () => Effect.succeed(false),
    outcome: () => Effect.succeed(Option.none()),
    recover: () => Effect.void,
    intervene: () => Effect.void,
    interrupt: () => Effect.void,
    occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
    sweep: Effect.void,
    discard: () => Effect.void,
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

/**
 * Returns a `StepExecutor` whose Worker `local` has `slots` slots, counted in `leased` as the
 * scheduler counts them; `occupy` takes a slot even past them. Each Attempt runs the next of
 * `plans`. Every `interrupt` call is added to `stops` with its reason, and fails while
 * `unstoppable` is true, as when the parent task can't be confirmed stopped.
 */
export const slottedExecutor = Effect.fn("test.slottedExecutor")(function* (
  plans: ReadonlyArray<AttemptPlan>,
  slots = 1,
) {
  const local = WorkerName.make("local");
  const leased = yield* TxRef.make(0);
  const unstoppable = yield* Ref.make(false);
  const stops = yield* Ref.make<ReadonlyArray<readonly [AttemptId, StopReason]>>([]);
  const remaining = yield* Ref.make(plans);
  const lease = () => ({ worker: local, release: TxRef.update(leased, (count) => count - 1) });
  const executor = Layer.succeed(StepExecutor)({
    workers: Effect.succeed([local]),
    isLive: () => Effect.succeed(false),
    outcome: () => Effect.succeed(Option.none()),
    recover: () => Effect.void,
    intervene: () => Effect.void,
    interrupt: (attemptId, reason) =>
      Effect.gen(function* () {
        yield* Ref.update(stops, (seen) => [...seen, [attemptId, reason] as const]);
        if (yield* Ref.get(unstoppable))
          return yield* new InfraFailure({
            message: "Could not cancel the parent task",
            cause: "storage unavailable",
          });
      }),
    occupy: () => TxRef.update(leased, (count) => count + 1).pipe(Effect.map(lease)),
    sweep: Effect.void,
    discard: () => Effect.void,
    reserve: () =>
      Effect.tx(
        Effect.gen(function* () {
          if ((yield* TxRef.get(leased)) >= slots) return yield* Effect.txRetry;
          yield* TxRef.update(leased, (count) => count + 1);
        }),
      ).pipe(Effect.map(lease)),
    execute: (_, io) =>
      io.checkoutAcquired.pipe(
        Effect.andThen(
          Ref.modify(remaining, ([next, ...rest]) => [next, rest] as const).pipe(
            Effect.flatMap(
              (plan) => plan ?? Effect.die("The test StepExecutor ran out of scripted attempts"),
            ),
          ),
        ),
      ),
  });
  return { leased, unstoppable, stops, executor };
});

export const submission = (options: {
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

/** A web UI approval by the operator login from `usine.yaml`. */
export const uiApproval = new ApprovalSource({
  channel: "ui",
  approver: Option.some(OperatorLogin.make("operator")),
});

export const approvalEvent = (number: number) => {
  const second = String(number).padStart(2, "0");
  return new Event({
    id: EventId.make(`approval-${number}`),
    dedupKey: DedupKey.make(`approval/run-${number}`),
    payload: { approved: true },
    receivedAt: DateTime.makeUnsafe(`2026-08-24T13:00:${second}Z`),
  });
};

export const waitFor = Effect.fn("test.waitFor")(function* (
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

export const withInstance = <A, E, R>(
  use: (directory: InstanceDirectory) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fileSystem.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-engine-",
      }),
    );
    return yield* use(directory);
  }).pipe(Effect.provide(NodeServices.layer));

/**
 * Writes state through the store only, as a process would before stopping, so a test can then
 * start the engine on the same instance.
 */
export const committedBeforeCrash = <A, E>(
  directory: InstanceDirectory,
  write: (store: RunStore["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* write(yield* RunStore);
  }).pipe(Effect.provide(RunStore.layer.pipe(Layer.provide(localSqliteLayer(directory)))));
