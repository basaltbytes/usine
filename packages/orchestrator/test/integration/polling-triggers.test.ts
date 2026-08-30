import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentFile,
  AgentName,
  IssueTrigger,
  LoadedInstance,
  LoopFile,
  LoopName,
  ModelId,
  Persona,
  PromptTemplate,
  Selector,
  UsineConfig,
} from "@usine/config";
import { Instance, Repository, Run, Step } from "@usine/core";
import { RunEngine, StepExecutor } from "@usine/engine";
import { layer as localEngineLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer, Source } from "@usine/expression";
import { GitHubApp, GitHubPollingLayer, IssuePayload } from "@usine/github";
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
import { PollingTriggers } from "../../src/index.ts";

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

const repositoryApi = (repository: Repository.Name): string =>
  `https://api.github.com/repos/${repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;

const makeInstance = (repository: Repository.Name, label: string): LoadedInstance => {
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
    persona: Persona.make("Exercise the polling integration path."),
  });
  const loop = new LoopFile({
    name: LoopName.make("integration-label"),
    trigger: new IssueTrigger({
      on: "issue",
      if: Source.make(`item.labels.nodes.exists(label, label.name == ${JSON.stringify(label)})`),
    }),
    selector: Option.some(
      new Selector({ repos: Option.some([config.repos[0]!.name]), tags: Option.none() }),
    ),
    approval: "required",
    step: Step.StepName.make("run"),
    agent: agent.name,
    body: PromptTemplate.make("Integration test."),
  });
  return new LoadedInstance({
    config,
    agents: [agent],
    invalidAgents: [],
    loops: [loop],
    quarantinedLoops: [],
  });
};

const runtimeLayer = (directory: Instance.Directory, app: GitHubApp["Service"]) => {
  const executor = Layer.succeed(StepExecutor)({
    execute: () => Effect.die("the approval-gated integration run must not execute"),
  });
  const engine = localEngineLayer(directory).pipe(Layer.provide(executor));
  const polling = GitHubPollingLayer.pipe(
    Layer.provide(Layer.succeed(GitHubApp, app)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );
  const dependencies = Layer.mergeAll(engine, MarcbachmannCelLayer, polling);
  return Layer.merge(dependencies, PollingTriggers.layer.pipe(Layer.provide(dependencies)));
};

const openRuntime = Effect.fn("integration.openRuntime")(function* (
  directory: Instance.Directory,
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
): Option.Option<Run.RunId> => {
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
      const repository = Repository.Name.make(settings.repository);
      const label = `usine-poll-${globalThis.crypto.randomUUID()}`;
      const instance = makeInstance(repository, label);
      const fileSystem = yield* FileSystem.FileSystem;
      const runtimeDirectory = Instance.Directory.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-live-polling-" }),
      );
      const credentialsDirectory = Instance.Directory.make(settings.credentialsDirectory);
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
                    let originalRun = Option.none<Run.RunId>();
                    while (Option.isNone(originalRun) && Date.now() <= deadline) {
                      const cycle = yield* polling.poll(instance);
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
                    if (Option.isSome(unchangedRun)) {
                      assert.strictEqual(unchangedRun.value, runId);
                    }
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
                    if (Option.isSome(restartedRun)) {
                      assert.strictEqual(restartedRun.value, first.runId);
                    }
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
