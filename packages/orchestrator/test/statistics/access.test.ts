import { WorkerStatus } from "../../src/worker-status.ts";
import { MachineStarts } from "@usine/executor";
import { WorkerName } from "@usine/core/worker";
import { assert, it } from "@effect/vitest";
import { RequestPermissions, RoleBinding, ProjectScope, GitHubUserId } from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { Agent } from "@usine/core/agent";
import { AttemptTask } from "@usine/core/attempt";
import { Run, RunId } from "@usine/core/run";
import { EventId } from "@usine/core/event";
import { LoopName } from "@usine/core/loop";
import * as RunState from "@usine/core/run/state";
import { Step, StepName } from "@usine/core/step";
import { ItemKey } from "@usine/core/item";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { ItemProjectionReader } from "@usine/engine/item-projection";
import { RunReader, RunSummary, ProjectionRevision } from "@usine/engine/run-reader";
import { CycleBudgets } from "@usine/engine/cycle-budget";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { OperatorStatistics } from "../../src/operator/statistics/statistics.ts";
import { RunUsageReader } from "../../src/operator/usage.ts";
import { configurationLayer } from "../support/configuration.ts";
import { emptyCycleBudgets } from "../support/polling.ts";

const repository = RepositoryName.make("acme/visible");
const id = RunId.make("visible-run");
const time = DateTime.makeUnsafe("2026-11-01T00:00:00Z");
const summary = new RunSummary({
  itemKey: ItemKey.make("visible-item"),
  repository,
  run: new Run({
    id,
    eventId: EventId.make("event"),
    loop: LoopName.make("alpha/work"),
    state: new RunState.Succeeded(),
    openedAt: time,
  }),
  step: new Step({ runId: id, name: StepName.make("run"), result: Option.none() }),
  attempts: [],
  resolvedFailureAttemptId: Option.none(),
  closedAt: Option.some(time),
  approval: Option.none(),
  runAgain: Option.none(),
  task: AttemptTask.make("Work."),
  agent: Schema.decodeUnknownSync(Agent)({
    name: "developer",
    brain: { harness: "codex", model: "test", effort: "high" },
    parentModel: null,
    persona: "Work.",
  }),
});

it.effect("isolates project statistics from cached admin results and hides worker capacity", () =>
  Effect.gen(function* () {
    const hidden = RepositoryName.make("acme/hidden");
    const loaded = new LoadedInstance({
      agents: [],
      loops: [],
      invalidAgents: [],
      quarantinedLoops: [],
      warnings: [],
      config: Schema.decodeUnknownSync(UsineConfig)({
        version: 2,
        repos: [{ name: repository }, { name: hidden }],
        projects: [
          { id: "alpha", name: "Alpha", repositories: [repository] },
          { id: "beta", name: "Beta", repositories: [hidden] },
        ],
        bindings: [
          {
            name: "beta-viewer",
            member: 2,
            role: "viewer",
            scope: { _tag: "Project", project: "beta" },
          },
        ],
      }),
    });
    const grants = new RoleBinding({
      name: "viewer",
      member: GitHubUserId.make(1),
      role: "viewer",
      scope: new ProjectScope({ project: ProjectId.make("alpha") }),
    }).permissions;
    const reader = Layer.mock(RunReader)({
      closedSince: () =>
        Effect.succeed([
          summary,
          new RunSummary({
            ...summary,
            repository: hidden,
            run: new Run({ ...summary.run, id: RunId.make("hidden-run") }),
          }),
        ]),
      list: () => Effect.succeed([]),
      revision: () => Effect.succeed(Option.some(ProjectionRevision.make(1))),
      transcript: () => Effect.succeed([]),
    });
    yield* OperatorStatistics.use(({ runStatistics }) =>
      Effect.gen(function* () {
        const admin = yield* runStatistics(loaded, "all");
        assert.equal(admin.runs.succeeded, 2);
        assert.equal(admin.machineStarts[0]?.count, 3);
        const scoped = yield* runStatistics(loaded, "all").pipe(
          Effect.provideService(RequestPermissions, grants),
        );
        assert.equal(scoped.runs.succeeded, 1);
        assert.deepEqual(scoped.utilization, []);
        assert.deepEqual(scoped.machineStarts, []);
        assert.equal(
          (yield* runStatistics(loaded, "all").pipe(Effect.provideService(RequestPermissions, [])))
            .runs.succeeded,
          0,
        );
        assert.equal((yield* runStatistics(loaded, "all")).runs.succeeded, 2);
      }),
    ).pipe(
      Effect.provide(
        OperatorStatistics.layer.pipe(
          Layer.provide(
            Layer.mock(WorkerStatus)({
              machineStarts: Effect.succeed([
                new MachineStarts({
                  worker: WorkerName.make("worker"),
                  provider: "boat",
                  day: DateTime.formatIso(yield* DateTime.now).slice(0, 10),
                  count: 3,
                }),
              ]),
            }),
          ),
          Layer.provide(configurationLayer),
          Layer.provide(RunUsageReader.layer),
          Layer.provide(reader),
          Layer.provide(Layer.mock(ItemProjectionReader)({})),
          Layer.provide(Layer.succeed(CycleBudgets, emptyCycleBudgets)),
        ),
      ),
    );
  }),
);
