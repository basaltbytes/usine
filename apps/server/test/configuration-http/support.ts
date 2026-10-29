import { ItemProjectionReader, ItemProjection } from "@usine/engine/item-projection";
import { NodeServices } from "@effect/platform-node";
import { localSqliteLayer } from "@usine/engine/local-sqlite";

import { GitHubPolling } from "@usine/github/polling";

import {
  ConfigurationStore,
  ConfigurationStoreError,
  ConfigurationRevisionNumber,
  configurationDiff,
  configurationEntities,
} from "@usine/config/configuration";
import { memoryConfigurationLayer } from "@usine/config/memory";
import { ConfigParser } from "@usine/config/parser";
import { LoadedInstance } from "@usine/config/instance";
import { InstancePath } from "@usine/config/file";
import { InstanceDirectory } from "@usine/core/instance";
import { LoopName } from "@usine/core/loop";
import { BotAccount, BotLogin, BotUserId } from "@usine/core/worker";
import { LoopControl, LoopRuntimeState } from "@usine/engine/loop-control";
import { RepositoryLabelProjectionReader } from "@usine/engine/repository-label-projection";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Executor, fullPreflight, WorkerCapabilityError } from "@usine/executor";
import { GitHubApp } from "@usine/github/github-app";
import { CurrentInstance } from "@usine/orchestrator/current-instance";
import { ConfigurationEditor, OperatorConfiguration } from "@usine/orchestrator/operator";
import { idleTriggersLayer } from "@usine/orchestrator/idle-triggers";
import { stepExecutorLayer } from "@usine/orchestrator/scheduler";
import { WorkerStatus } from "@usine/orchestrator/worker-status";
import { Context, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { FactoryBackend } from "../../src/backend.ts";
import { apiRoutes } from "../../src/http.ts";
import { configurationLoopControlLayer } from "../../src/configuration/store.ts";

const parserLayer = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
export const unused = () => Effect.die("unused test service operation");
export const agentText = "---\nharness: codex\nmodel: gpt-6.1-sol\neffort: high\n---\nImplement.\n";
export const loopText =
  "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n---\nImplement.\n";

export const harness = (
  catalog: Layer.Layer<GitHubApp | GitHubPolling> | Layer.Layer<never> = Layer.empty,
) =>
  Effect.gen(function* () {
    const projections = yield* Ref.make<readonly ItemProjection[]>([]);
    const states = yield* Ref.make(new Map<LoopName, LoopRuntimeState>());
    const setPause = (loop: LoopName, paused: boolean) =>
      Ref.modify(states, (previous) => {
        const state = new LoopRuntimeState({ loop, paused });
        return [state, new Map(previous).set(loop, state)];
      });
    const controls = LoopControl.of({
      isPaused: (loop) => Ref.get(states).pipe(Effect.map((all) => all.get(loop)?.paused ?? false)),
      states: Ref.get(states).pipe(Effect.map((all) => [...all.values()])),
      pause: (loop) => setPause(loop, true),
      unpause: (loop) => setPause(loop, false),
    });
    const controlLayer = Layer.succeed(LoopControl, controls);
    const directory = yield* FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "usine-configuration-http-" })),
      Effect.map(InstanceDirectory.make),
      Effect.provide(NodeServices.layer),
    );
    const storeLayer = configurationLoopControlLayer.pipe(
      Layer.provide(memoryConfigurationLayer),
      Layer.provide(controlLayer),
      Layer.provideMerge(parserLayer),
      Layer.provide(localSqliteLayer(directory)),
      Layer.provide(NodeServices.layer),
    );
    const base = yield* Layer.build(storeLayer);
    const parser = Context.get(base, ConfigParser);
    const underlyingStore = Context.get(base, ConfigurationStore);
    const failNextCommit = yield* Ref.make(Option.none<ConfigurationStoreError>());
    const store = ConfigurationStore.of({
      ...underlyingStore,
      commit: (request) =>
        Ref.getAndSet(failNextCommit, Option.none()).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => underlyingStore.commit(request),
              onSome: Effect.fail,
            }),
          ),
        ),
    });
    const services = Context.add(base, ConfigurationStore, store);
    const initial = new LoadedInstance({
      config: yield* parser.parseUsineYaml(
        InstancePath.make("usine.yaml"),
        "version: 2\noperator: operator\nprojects: [{ id: acme-project, name: Project, repositories: [acme/project] }, { id: acme-other, name: Other, repositories: [acme/other] }]\nrepos:\n  - name: acme/project\n    tags: [app]\n  - name: acme/other\n    tags: [other]\n",
      ),
      agents: [yield* parser.parseAgentFile(InstancePath.make("agents/developer.md"), agentText)],
      loops: [
        yield* parser.parseLoopFile(
          InstancePath.make("projects/acme-project/loops/implement.md"),
          loopText,
        ),
      ],
      invalidAgents: [],
      quarantinedLoops: [],
      warnings: [],
    });
    const first = yield* store.commit({
      expected: ConfigurationRevisionNumber.make(0),
      actor: initial.config.operator,
      message: Option.some("Initial import"),
      changes: configurationDiff([], configurationEntities(initial)),
    });
    const currentContext = yield* Layer.build(
      CurrentInstance.layer(InstanceDirectory.make("/instance"), initial, first.number).pipe(
        Layer.provide(Layer.succeedContext(services)),
      ),
    );
    const current = Context.get(currentContext, CurrentInstance);
    const preflightAction = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const workers = new Map(initial.config.workers.map((worker) => [worker.name, worker]));
    const currentLayer = Layer.succeed(CurrentInstance, current);
    const scheduler = yield* Layer.build(
      stepExecutorLayer(
        initial.config,
        initial.agents.map(({ agent }) => agent.brain),
        {
          workers: {
            add: (worker) =>
              Effect.sync(() => {
                workers.set(worker.name, worker);
              }),
            remove: (worker) =>
              Effect.sync(() => {
                workers.delete(worker);
              }),
          },
        },
      ).pipe(
        Layer.provide(currentLayer),
        Layer.provide(
          Layer.succeed(Executor, {
            kind: "local",
            recover: unused,
            isLive: unused,
            outcome: unused,
            prepare: unused,
            cancel: unused,
            intervene: unused,
            sweep: Effect.void,
            preflight: (worker) =>
              Ref.getAndSet(preflightAction, Effect.void).pipe(
                Effect.flatten,
                Effect.andThen(
                  worker === "broken"
                    ? Effect.fail(
                        new WorkerCapabilityError({
                          worker,
                          capability: "memory",
                          message: "Insufficient memory",
                          cause: "private observation",
                        }),
                      )
                    : Effect.succeed(fullPreflight),
                ),
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(GitHubApp, {
            installation: unused,
            botAccount: () =>
              Effect.succeed(
                new BotAccount({ login: BotLogin.make("test[bot]"), id: BotUserId.make(1) }),
              ),
            repositories: () => Effect.die("unused installation repositories"),
            installationToken: unused,
            projectAccess: unused,
            deliveries: () => Effect.die("unused webhook deliveries"),
            workerToken: unused,
          }),
        ),
      ),
    );
    const editorContext = yield* Layer.build(
      ConfigurationEditor.layer.pipe(
        Layer.provide(MarcbachmannCelLayer),
        Layer.provide(
          Layer.succeed(ItemProjectionReader, {
            get: unused,
            openIssues: unused,
            list: (repository) =>
              Ref.get(projections).pipe(
                Effect.map((items) => items.filter((item) => item.repository === repository)),
              ),
          }),
        ),
        Layer.provide(currentLayer),
        Layer.provide(Layer.succeedContext(services)),
      ),
    );
    const viewContext = yield* Layer.build(
      OperatorConfiguration.layer.pipe(
        Layer.provide(controlLayer),
        Layer.provide(idleTriggersLayer),
        Layer.provide(Layer.succeedContext(scheduler)),
        Layer.provide(
          Layer.succeed(RepositoryLabelProjectionReader, {
            get: () => Effect.succeed(Option.none()),
          }),
        ),
      ),
    );
    const views = Context.get(viewContext, OperatorConfiguration);
    const backend = Layer.succeed(FactoryBackend, {
      configuration: current.get.pipe(Effect.flatMap(views.view)),
      overview: Effect.die("unused"),
      detail: unused,
      githubChanges: unused,
      approve: unused,
      dismissNeed: unused,
      undoDismissNeed: unused,
      resetCycleBudget: unused,
      resolveFailure: unused,
      retry: unused,
      agents: Effect.die("unused"),
      editAndRetry: unused,
      runAgain: unused,
      intervene: unused,
      cancel: unused,
      discardLeftovers: unused,
      moveBoardItem: unused,
      pause: unused,
      unpause: unused,
      task: unused,
      desk: Effect.die("unused"),
      statistics: unused,
      runStatistics: unused,
    });
    const app = HttpRouter.toWebHandler(
      apiRoutes(Option.none()).pipe(
        HttpRouter.provideRequest(
          Layer.mergeAll(backend, Layer.succeedContext(editorContext), catalog),
        ),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
    const request = (method: string, path: string, body?: Schema.Json) =>
      Effect.promise(async () => {
        const options: RequestInit = { method };
        if (body !== undefined) options.body = JSON.stringify(body);
        const response = await app.handler(
          new Request(`http://localhost/api/configuration${path}`, options),
        );
        const value: unknown = await response.json();
        return { status: response.status, body: value };
      });
    return {
      request,
      projections,
      store,
      current,
      controls,
      preflightAction,
      failNextCommit,
      workers,
      status: Context.get(scheduler, WorkerStatus),
    };
  });
