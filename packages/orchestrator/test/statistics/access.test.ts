import { WorkerStatus } from "../../src/worker-status.ts";
import { MachineStarts } from "@usine/executor";
import { WorkerName } from "@usine/core/worker";
import { assert, it } from "@effect/vitest";
import { RequestPermissions, RoleBinding, ProjectScope, GitHubUserId } from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { Agent } from "@usine/core/agent";
import { Run, RunId } from "@usine/core/run";
import { EventId } from "@usine/core/event";
import { LoopName } from "@usine/core/loop";
import * as RunState from "@usine/core/run/state";
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
const summary = Effect.gen(function* () {
  const decodedValue1 = yield* Schema.decodeEffect(Agent)({
    name: "developer",
    brain: { harness: "codex", model: "test", effort: "high" },
    parentModel: null,
    persona: "Work.",
  });
  return RunSummary.make({
    itemKey: ItemKey.make("visible-item"),
    repository,
    run: Run.make({
      id,
      eventId: EventId.make("event"),
      loop: LoopName.make("alpha/work"),
      state: RunState.Succeeded.make(),
      openedAt: time,
    }),
    pullRequestUrl: null,
    attempts: [],
    resolvedFailureAttemptId: Option.none(),
    closedAt: Option.some(time),
    approval: Option.none(),
    runAgain: Option.none(),
    agent: decodedValue1,
  });
});

it.effect("isolates project statistics from cached admin results and hides worker capacity", () =>
  Effect.gen(function* () {
    const fixtureValue1 = yield* Effect.context<never>();
    const runFixture = Effect.runSyncWith(fixtureValue1);

    const hidden = RepositoryName.make("acme/hidden");
    const decodedValue2 = yield* Schema.decodeEffect(UsineConfig)({
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
    });
    const loaded = LoadedInstance.make({
      agents: [],
      loops: [],
      invalidAgents: [],
      quarantinedLoops: [],
      warnings: [],
      config: decodedValue2,
    });
    const grants = RoleBinding.make({
      name: "viewer",
      member: GitHubUserId.make(1),
      role: "viewer",
      scope: ProjectScope.make({ project: ProjectId.make("alpha") }),
    }).permissions;
    const reader = Layer.mock(RunReader)({
      closedSince: () =>
        Effect.succeed([
          runFixture(summary),
          RunSummary.make({
            ...runFixture(summary),
            repository: hidden,
            run: Run.make({ ...runFixture(summary).run, id: RunId.make("hidden-run") }),
          }),
        ]),
      list: () => Effect.succeed([]),
      revision: Effect.succeedSome(ProjectionRevision.make(1)),
      transcript: () => Effect.succeed([]),
    });
    const currentNow = yield* DateTime.now;
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
        const decodedValue3 = yield* runStatistics(loaded, "all").pipe(
          Effect.provideService(RequestPermissions, []),
        );
        assert.equal(decodedValue3.runs.succeeded, 0);

        assert.equal((yield* runStatistics(loaded, "all")).runs.succeeded, 2);
      }),
    ).pipe(
      Effect.provide(
        OperatorStatistics.layer.pipe(
          Layer.provide(
            Layer.mock(WorkerStatus)({
              machineStarts: Effect.succeed([
                MachineStarts.make({
                  worker: WorkerName.make("worker"),
                  provider: "boat",
                  day: DateTime.formatIso(currentNow).slice(0, 10),
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
