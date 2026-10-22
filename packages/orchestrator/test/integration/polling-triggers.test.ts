import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ModelId } from "@usine/core/agent/brain";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { AgentFile } from "@usine/config/agent";
import { IssueTrigger } from "@usine/config/trigger";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { LoopName } from "@usine/core/loop";
import { Selector } from "@usine/config/selector";
import { UsineConfig } from "@usine/config/factory";
import { ConfigParser } from "@usine/config/parser";
import { InstanceDirectory } from "@usine/core/instance";
import { RunEngine } from "@usine/engine/engine";
import { StepExecutor } from "@usine/engine/step-executor";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Source } from "@usine/expression/expression-engine";
import { GitHubApp } from "@usine/github/github-app";
import { GitHubLabelWriter } from "@usine/github/label-writer";
import { IssuePayload, GitHubPolling } from "@usine/github/polling";
import { localSecretsLayer } from "@usine/github/local-secrets";
import {
  Config,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Scope,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { LabelReconciler } from "../../src/label-reconciler.ts";
import { PollingTriggers } from "../../src/polling-triggers.ts";
import { alwaysHoldsLayer } from "../support/polling.ts";

const PositiveIntFromString = Schema.FiniteFromString.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
);

const request = Effect.fn("integration.request")(function* (
  token: string,
  url: string,
  init: RequestInit,
  expectedStatus: number,
) {
  const response = yield* Effect.tryPromise(() =>
    fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2026-03-10",
      },
    }),
  );
  if (response.status !== expectedStatus) {
    return yield* Effect.die(
      `GitHub returned ${response.status} for ${init.method ?? "GET"} ${url}`,
    );
  }
});

const repositoryApi = (repository: RepositoryName): string =>
  `https://api.github.com/repos/${repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;

const makeInstance = (repository: RepositoryName, label: string): LoadedInstance => {
  const config = Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [{ name: repository, tags: ["integration"] }],
    settings: { poll_interval: 15 },
  });
  const agent = new AgentFile({
    name: AgentName.make("integration-agent"),
    harness: "codex",
    model: ModelId.make("gpt-5.6-sol"),
    effort: "high",
    parentModel: Option.none(),
    parentEffort: Option.none(),
    persona: AgentPersona.make("Exercise the polling integration path."),
  });
  const loop = new LoopFile({
    name: LoopName.make("integration-label"),
    trigger: new IssueTrigger({
      on: "issue",
      if: Source.make(`item.labels.nodes.exists(label, label.name == ${JSON.stringify(label)})`),
    }),
    selector: Option.some(
      new Selector({
        repos: Option.some([config.repos[0]?.name ?? assert.fail("missing integration repo")]),
        tags: Option.none(),
      }),
    ),
    approval: "required",
    step: StepName.make("run"),
    agent: agent.name,
    body: PromptTemplate.make("Integration test."),
  });
  return new LoadedInstance({
    config,
    agents: [agent],
    invalidAgents: [],
    loops: [loop],
    quarantinedLoops: [],
    warnings: [],
  });
};

const runtimeLayer = (directory: InstanceDirectory, app: GitHubApp["Service"]) => {
  const executor = Layer.succeed(StepExecutor)({
    workers: Effect.succeed([WorkerName.make("local")]),
    isLive: () => Effect.succeed(false),
    outcome: () => Effect.succeed(Option.none()),
    recover: () => Effect.void,
    intervene: () => Effect.void,
    interrupt: () => Effect.void,
    occupy: (worker) => Effect.succeed({ worker, release: Effect.void }),
    reserve: () => Effect.die("the approval-gated integration run must not reserve a worker"),
    execute: () => Effect.die("the approval-gated integration run must not execute"),
  });
  const engine = localEngineLayer(directory).pipe(
    Layer.provide(executor),
    Layer.provide(alwaysHoldsLayer),
  );
  const polling = GitHubPolling.layer.pipe(
    Layer.provide(Layer.succeed(GitHubApp, app)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );
  const labelWriter = GitHubLabelWriter.layer.pipe(
    Layer.provide(Layer.succeed(GitHubApp, app)),
    Layer.provide(FetchHttpClient.layer),
  );
  const labelReconciler = LabelReconciler.layer.pipe(Layer.provide(labelWriter));
  const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
  const dependencies = Layer.mergeAll(
    engine,
    labelReconciler,
    MarcbachmannCelLayer,
    parser,
    polling,
  );
  return Layer.merge(dependencies, PollingTriggers.layer.pipe(Layer.provide(dependencies)));
};

const openRuntime = Effect.fn("integration.openRuntime")(function* (
  directory: InstanceDirectory,
  app: GitHubApp["Service"],
) {
  const scope = yield* Scope.make();
  const context = yield* Scope.provide(Layer.build(runtimeLayer(directory, app)), scope);
  return {
    scope,
    polling: Context.get(context, PollingTriggers),
    engine: Context.get(context, RunEngine),
  };
});

const closeRuntime = ({ scope }: Effect.Success<ReturnType<typeof openRuntime>>) =>
  Scope.close(scope, Exit.void);

const runIdFrom = (
  submissions: Effect.Success<ReturnType<PollingTriggers["Service"]["poll"]>>["submissions"],
): Option.Option<RunId> => {
  const first = submissions[0];
  return first === undefined || first._tag !== "Claimed" ? Option.none() : Option.some(first.runId);
};

describe("live GitHub polling", () => {
  it.live("deduplicates across restart and sees a label flip within one interval", () =>
    Effect.gen(function* () {
      const settings = yield* Effect.all({
        credentialsDirectory: Config.string("USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY"),
        repository: Config.string("USINE_GITHUB_INTEGRATION_REPO"),
        issueNumber: Config.schema(PositiveIntFromString, "USINE_GITHUB_INTEGRATION_ISSUE_NUMBER"),
      });
      const repository = RepositoryName.make(settings.repository);
      const label = `usine-poll-${globalThis.crypto.randomUUID()}`;
      const instance = makeInstance(repository, label);
      const fileSystem = yield* FileSystem.FileSystem;
      const runtimeDirectory = InstanceDirectory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-live-polling-" }),
      );
      const credentialsDirectory = InstanceDirectory.make(settings.credentialsDirectory);
      const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer);
      const credentialsLayer = localSecretsLayer(credentialsDirectory).pipe(
        Layer.provide(platformLayer),
      );
      const appLayer = GitHubApp.layer.pipe(
        Layer.provide(credentialsLayer),
        Layer.provide(FetchHttpClient.layer),
      );

      yield* Effect.gen(function* () {
        const app = yield* GitHubApp;
        const installationToken = yield* app.installationToken();
        const token = Redacted.value(installationToken.value);
        const api = repositoryApi(repository);

        yield* Effect.acquireUseRelease(
          request(
            token,
            `${api}/labels`,
            { method: "POST", body: JSON.stringify({ name: label, color: "6f42c1" }) },
            201,
          ),
          () =>
            Effect.gen(function* () {
              const first = yield* Effect.acquireUseRelease(
                openRuntime(runtimeDirectory, app),
                ({ engine, polling }) =>
                  Effect.gen(function* () {
                    yield* polling.poll(instance);
                    yield* request(
                      token,
                      `${api}/issues/${settings.issueNumber}/labels`,
                      { method: "POST", body: JSON.stringify({ labels: [label] }) },
                      200,
                    );

                    const deadline = Date.now() + instance.config.settings.pollInterval * 1_000;
                    let originalRun = Option.none<RunId>();
                    while (Option.isNone(originalRun) && Date.now() <= deadline) {
                      const cycle = yield* polling.poll(instance);
                      if (cycle.failures.length > 0) {
                        return yield* Effect.die(
                          `polling failed: ${cycle.failures
                            .map(({ errorTag, message }) => `${errorTag}: ${message}`)
                            .join("; ")}`,
                        );
                      }
                      originalRun = runIdFrom(cycle.submissions);
                      if (Option.isNone(originalRun)) yield* Effect.sleep("1 second");
                    }
                    assert(Option.isSome(originalRun), "the label change did not produce an Event");
                    const runId = originalRun.value;
                    const snapshot = yield* engine.inspect(runId);
                    const eventPayload = Schema.decodeUnknownSync(IssuePayload)(
                      snapshot.event.payload,
                    );
                    assert(eventPayload.labels.nodes.some(({ name }) => name === label));

                    const unchanged = yield* polling.poll(instance);
                    const unchangedRun = runIdFrom(unchanged.submissions);
                    // An unchanged state either submits nothing (304 or empty
                    // page) or resolves to the same run, never a second one.
                    assert(
                      Option.isNone(unchangedRun) || unchangedRun.value === runId,
                      "an unchanged state must not open a second run",
                    );
                    return { eventId: snapshot.event.id, runId };
                  }),
                closeRuntime,
              );

              yield* Effect.acquireUseRelease(
                openRuntime(runtimeDirectory, app),
                ({ engine, polling }) =>
                  Effect.gen(function* () {
                    const afterRestart = yield* polling.poll(instance);
                    const restartedRun = runIdFrom(afterRestart.submissions);
                    // The same holds across a restart: the durable ledger, not
                    // the lost in-memory state, prevents a second run.
                    assert(
                      Option.isNone(restartedRun) || restartedRun.value === first.runId,
                      "a restart must not open a second run for the same state",
                    );
                    assert.strictEqual(
                      (yield* engine.inspect(first.runId)).event.id,
                      first.eventId,
                    );
                  }),
                closeRuntime,
              );
            }),
          () =>
            request(token, `${api}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }, 204),
        );
      }).pipe(Effect.provide(appLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
