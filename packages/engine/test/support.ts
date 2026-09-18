import { NodeServices } from "@effect/platform-node";
import { Agent, AgentPersona, AgentName } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptTask } from "@usine/core/attempt";
import type { AttemptFailure } from "@usine/core/attempt/failure";
import { Event, DedupKey, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { StepResult } from "@usine/core/step/result";
import { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, FileSystem, Layer, Option, Ref } from "effect";
import { layer } from "../src/database/local-sqlite.ts";
import type { RunEngine } from "../src/engine/engine.ts";
import { Submission } from "../src/engine/submission.ts";
import { StepExecutor } from "../src/step-executor.ts";
import { TriggerCondition } from "../src/trigger-condition.ts";

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

/** A `TriggerCondition` that gives every queued Event the same answer. */
export const conditionLayer = (holds: Effect.Effect<boolean>) =>
  Layer.succeed(TriggerCondition)({ holds: () => holds });

/**
 * The local engine over a scripted `StepExecutor`. Queued Events keep their
 * trigger unless the test supplies its own `TriggerCondition`.
 */
export const engineLayer = (
  directory: InstanceDirectory,
  executor: Layer.Layer<StepExecutor>,
  condition: Layer.Layer<TriggerCondition> = conditionLayer(Effect.succeed(true)),
) => layer(directory).pipe(Layer.provide(executor), Layer.provide(condition));

export const executorLayer = (plans: Ref.Ref<ReadonlyArray<AttemptPlan>>) =>
  Layer.succeed(StepExecutor)({
    recover: () => Effect.void,
    intervene: () => Effect.void,
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
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-engine-" }),
    );
    return yield* use(directory);
  }).pipe(Effect.provide(NodeServices.layer));
