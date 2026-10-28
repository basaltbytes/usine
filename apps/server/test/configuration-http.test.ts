import { expect, it } from "vitest";
import {
  ConfigurationStore,
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
import { BotAccount, BotLogin, BotUserId, WorkerName } from "@usine/core/worker";
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
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { FactoryBackend } from "../src/backend.ts";
import { apiRoutes } from "../src/http.ts";
import { configurationLoopControlLayer } from "../src/configuration/store.ts";

const parserLayer = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
const unused = () => Effect.die("unused test service operation");
const agentText = "---\nharness: codex\nmodel: gpt-6.1-sol\neffort: high\n---\nImplement.\n";
const loopText = "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n---\nImplement.\n";

const harness = Effect.gen(function* () {
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
  const storeLayer = configurationLoopControlLayer.pipe(
    Layer.provide(memoryConfigurationLayer),
    Layer.provide(controlLayer),
    Layer.provideMerge(parserLayer),
  );
  const services = yield* Layer.build(storeLayer);
  const parser = Context.get(services, ConfigParser);
  const store = Context.get(services, ConfigurationStore);
  const initial = new LoadedInstance({
    config: yield* parser.parseUsineYaml(
      InstancePath.make("usine.yaml"),
      "version: 1\noperator: operator\nrepos: []\n",
    ),
    agents: [yield* parser.parseAgentFile(InstancePath.make("agents/developer.md"), agentText)],
    loops: [yield* parser.parseLoopFile(InstancePath.make("loops/implement.md"), loopText)],
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
  const currentLayer = Layer.succeed(CurrentInstance, current);
  const scheduler = yield* Layer.build(
    stepExecutorLayer(
      initial.config,
      initial.agents.map(({ agent }) => agent.brain),
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
        }),
      ),
      Layer.provide(
        Layer.succeed(GitHubApp, {
          installation: unused,
          botAccount: () =>
            Effect.succeed(
              new BotAccount({ login: BotLogin.make("test[bot]"), id: BotUserId.make(1) }),
            ),
          installationToken: unused,
          projectAccess: unused,
          workerToken: unused,
        }),
      ),
    ),
  );
  const editorContext = yield* Layer.build(
    ConfigurationEditor.layer.pipe(
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
    reload: current.reload,
    task: unused,
    desk: Effect.die("unused"),
    statistics: unused,
    runStatistics: unused,
  });
  const app = HttpRouter.toWebHandler(
    apiRoutes(Option.none()).pipe(
      HttpRouter.provideRequest(Layer.merge(backend, Layer.succeedContext(editorContext))),
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
  return { request, store, current, controls, status: Context.get(scheduler, WorkerStatus) };
});

it("creates, reads, replaces and deletes entities with paginated and filtered revision history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request } = yield* harness;
      expect(yield* request("GET", "/entities/agent/developer")).toMatchObject({
        status: 200,
        body: { number: 1, value: { name: "developer", harness: "codex" }, text: agentText },
      });
      expect(
        yield* request("PUT", "/entities/label/ready", {
          expected: 1,
          message: "Add ready",
          value: { name: "ready" },
        }),
      ).toMatchObject({
        status: 200,
        body: { number: 2, actor: "operator", message: "Add ready" },
      });
      expect(
        yield* request("PUT", "/entities/label/ready", {
          expected: 2,
          text: "name: ready\ncolor: ff0000\n",
        }),
      ).toMatchObject({ status: 200, body: { number: 3 } });
      expect(yield* request("GET", "/entities/label/ready")).toMatchObject({
        status: 200,
        body: {
          number: 3,
          value: { name: "ready", color: "ff0000" },
          text: "name: ready\ncolor: ff0000\n",
        },
      });
      expect(yield* request("GET", "/revisions/3")).toMatchObject({
        status: 200,
        body: {
          number: 3,
          changes: [
            {
              key: { kind: "label", identifier: "ready" },
              before: { name: "ready" },
              after: { name: "ready", color: "ff0000" },
            },
          ],
        },
      });
      expect(yield* request("GET", "/revisions?limit=2")).toMatchObject({
        status: 200,
        body: { revisions: [{ number: 3 }, { number: 2 }], nextBefore: 2 },
      });
      expect(yield* request("GET", "/revisions?before=2&limit=2")).toMatchObject({
        status: 200,
        body: { revisions: [{ number: 1 }], nextBefore: null },
      });
      expect(yield* request("GET", "/revisions?kind=agent")).toMatchObject({
        status: 200,
        body: { revisions: [{ number: 1 }] },
      });
      expect(yield* request("GET", "/revisions?identifier=ready")).toMatchObject({
        status: 200,
        body: { revisions: [{ number: 3 }, { number: 2 }] },
      });
      expect(yield* request("GET", "/revisions?kind=label&identifier=missing")).toMatchObject({
        status: 200,
        body: { revisions: [] },
      });
      expect(yield* request("DELETE", "/entities/label/ready", { expected: 3 })).toMatchObject({
        status: 200,
        body: { number: 4 },
      });
      for (const path of [
        "/entities/label/ready",
        "/entities/nonsense/name",
        "/revisions/999",
        "/revisions?kind=nonsense",
      ])
        expect((yield* request("GET", path)).status).toBe(404);
      expect((yield* request("GET", "/revisions?limit=0")).status).toBe(400);
    }).pipe(Effect.scoped),
  ));

it("refuses stale, invalid and incompatible writes without storing a revision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request, store } = yield* harness;
      expect(
        yield* request("PUT", "/entities/label/ready", { expected: 0, value: { name: "ready" } }),
      ).toMatchObject({ status: 409, body: { error: "StaleRevision", expected: 0, current: 1 } });
      expect(
        yield* request("PUT", "/entities/label/ready", {
          expected: 1,
          value: { name: "ready", color: "wrong", description: 42 },
        }),
      ).toMatchObject({
        status: 422,
        body: {
          problems: [
            { entity: { kind: "label", identifier: "ready" }, path: ["color"] },
            { entity: { kind: "label", identifier: "ready" }, path: ["description"] },
          ],
        },
      });
      expect(
        yield* request("PUT", "/entities/settings/instance", {
          expected: 1,
          text: "version: 1\noperator: operator\nwebhooks: { mode: deliveries }\n",
        }),
      ).toMatchObject({
        status: 409,
        body: { error: "RestartRequiredError", fields: ["webhooks"] },
      });
      const preflight = yield* request("PUT", "/entities/worker/broken", {
        expected: 1,
        value: { name: "broken", kind: "local" },
      });
      expect(preflight).toMatchObject({
        status: 409,
        body: { error: "ReloadPreflightError", workers: ["broken"] },
      });
      expect(JSON.stringify(preflight)).not.toContain("private observation");
      const secret = yield* request("PUT", "/entities/worker/secret", {
        expected: 1,
        text: "name: secret\nkind: ssh\ndestination: host\nroot: /srv/usine\ngateway:\n  domain: gateway.test\n  destination: gateway\n  admin_token_env: sk-literal-secret\n",
      });
      expect(secret.status).toBe(422);
      expect(JSON.stringify(secret)).not.toContain("sk-literal-secret");
      expect(
        (yield* request("PUT", "/entities/label/ready", {
          expected: 1,
          value: { name: "ready" },
          text: "name: ready",
        })).status,
      ).toBe(400);
      expect(yield* request("DELETE", "/entities/agent/developer", { expected: 1 })).toMatchObject({
        status: 422,
        body: {
          problems: [{ entity: { kind: "loop", identifier: "implement" }, path: ["agent"] }],
        },
      });
      expect(
        yield* request("PUT", "/entities/loop/bad", {
          expected: 1,
          text: loopText.replace("'true'", "'missing.field'"),
        }),
      ).toMatchObject({
        status: 422,
        body: {
          problems: [{ entity: { kind: "loop", identifier: "bad" }, path: ["trigger", "if"] }],
        },
      });
      expect((yield* store.read).number).toBe(1);
    }).pipe(Effect.scoped),
  ));

it("reverts changes as a new revision and identifies entities changed by later revisions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request } = yield* harness;
      expect(
        (yield* request("PUT", "/entities/label/ready", { expected: 1, value: { name: "ready" } }))
          .status,
      ).toBe(200);
      expect(
        (yield* request("PUT", "/entities/label/ready", {
          expected: 2,
          value: { name: "ready", color: "ff0000" },
        })).status,
      ).toBe(200);
      expect(yield* request("POST", "/revisions/2/revert", { expected: 3 })).toMatchObject({
        status: 409,
        body: {
          error: "ConfigurationRevertBlocked",
          entities: [{ kind: "label", identifier: "ready" }],
        },
      });
      expect(
        yield* request("POST", "/revisions/3/revert", { expected: 3, message: "Restore ready" }),
      ).toMatchObject({ status: 200, body: { number: 4, message: "Restore ready" } });
      expect(yield* request("GET", "/entities/label/ready")).toMatchObject({
        status: 200,
        body: { number: 4, value: { name: "ready" } },
      });
      expect((yield* request("DELETE", "/entities/label/ready", { expected: 4 })).status).toBe(200);
      expect((yield* request("POST", "/revisions/5/revert", { expected: 5 })).status).toBe(200);
      expect((yield* request("GET", "/entities/label/ready")).status).toBe(200);
      expect(
        (yield* request("PUT", "/entities/label/extra", { expected: 6, value: { name: "extra" } }))
          .status,
      ).toBe(200);
      expect((yield* request("POST", "/revisions/7/revert", { expected: 7 })).status).toBe(200);
      expect((yield* request("GET", "/entities/label/extra")).status).toBe(404);
    }).pipe(Effect.scoped),
  ));

it("applies API changes to the configuration view and running scheduler, and pauses created loops", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request, controls, status } = yield* harness;
      expect(yield* controls.isPaused(LoopName.make("implement"))).toBe(false);
      expect(
        (yield* request("PUT", "/entities/worker/local", {
          expected: 1,
          value: { name: "local", kind: "local", max_concurrent_attempts: 3 },
        })).status,
      ).toBe(200);
      expect(yield* status.slots).toMatchObject([
        { worker: WorkerName.make("local"), capacity: 3 },
      ]);
      expect(yield* request("GET", "")).toMatchObject({
        status: 200,
        body: { workers: [{ name: "local", maxConcurrentAttempts: 3, slots: { capacity: 3 } }] },
      });
      expect(
        (yield* request("PUT", "/entities/loop/review", { expected: 2, text: loopText })).status,
      ).toBe(200);
      expect(yield* controls.isPaused(LoopName.make("review"))).toBe(true);
      expect(yield* request("GET", "")).toMatchObject({
        status: 200,
        body: {
          loops: expect.arrayContaining(
            [{ name: "review", paused: true }].map((value) => expect.objectContaining(value)),
          ),
        },
      });
      expect(
        (yield* request("PUT", "/entities/worker/extra", {
          expected: 3,
          position: 0,
          value: { name: "extra", kind: "local" },
        })).status,
      ).toBe(200);
      expect((yield* status.slots).map(({ worker }) => worker)).toEqual(["extra", "local"]);
      expect((yield* request("POST", "/revisions/4/revert", { expected: 4 })).status).toBe(200);
      expect((yield* status.slots).map(({ worker }) => worker)).toEqual(["local"]);
    }).pipe(Effect.scoped),
  ));

it("preserves encoded identifiers and accepts only one of two writes to the same revision", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request, store } = yield* harness;
      const results = yield* Effect.all(
        [
          request("PUT", "/entities/repository/owner%2Frepo", {
            expected: 1,
            value: { name: "owner/repo" },
          }),
          request("PUT", "/entities/label/ready", { expected: 1, value: { name: "ready" } }),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
      expect((yield* store.read).number).toBe(2);
      const saved = yield* request("PUT", "/entities/repository/owner%2Frepo", {
        expected: 2,
        value: { name: "owner/repo" },
      });
      expect(saved.status).toBe(200);
      expect(yield* request("GET", "/entities/repository/owner%2Frepo")).toMatchObject({
        status: 200,
        body: {
          key: { kind: "repository", identifier: "owner/repo" },
          value: { name: "owner/repo" },
        },
      });
    }).pipe(Effect.scoped),
  ));

it("restores worker order when reverting a move or deletion", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request, status } = yield* harness;
      expect(
        (yield* request("PUT", "/entities/worker/extra", {
          expected: 1,
          value: { name: "extra", kind: "local" },
          position: 0,
        })).status,
      ).toBe(200);
      expect(
        (yield* request("PUT", "/entities/worker/local", {
          expected: 2,
          value: { name: "local", kind: "local" },
          position: 0,
        })).status,
      ).toBe(200);
      expect((yield* status.slots).map(({ worker }) => worker)).toEqual(["local", "extra"]);
      expect((yield* request("POST", "/revisions/3/revert", { expected: 3 })).status).toBe(200);
      expect((yield* status.slots).map(({ worker }) => worker)).toEqual(["extra", "local"]);
      expect((yield* request("DELETE", "/entities/worker/extra", { expected: 4 })).status).toBe(
        200,
      );
      expect((yield* request("POST", "/revisions/5/revert", { expected: 5 })).status).toBe(200);
      expect((yield* status.slots).map(({ worker }) => worker)).toEqual(["extra", "local"]);
    }).pipe(Effect.scoped),
  ));
