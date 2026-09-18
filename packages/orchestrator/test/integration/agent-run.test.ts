import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { AgentName, AgentPersona } from "@usine/core/agent";
import { RepositoryName } from "@usine/core/repository";
import { RunId } from "@usine/core/run";
import { StepName } from "@usine/core/step";
import { AgentFile } from "@usine/config/agent";
import { IssueTrigger } from "@usine/config/trigger";
import { LoadedInstance } from "@usine/config/instance";
import { LoopFile, PromptTemplate } from "@usine/config/loop";
import { LoopName } from "@usine/core/loop";
import { Selector } from "@usine/config/selector";
import { UsineConfig } from "@usine/config/factory";
import { ConfigParser } from "@usine/config/parser";
import { ModelId } from "@usine/core/agent/brain";
import { InstanceDirectory } from "@usine/core/instance";
import { RunEngine } from "@usine/engine/engine";
import { TranscriptAllQuery } from "@usine/engine/transcript";
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
import { gitHubCredentialLayer } from "../../src/credentials.ts";
import { LabelReconciler } from "../../src/label-reconciler.ts";
import { PollingTriggers } from "../../src/polling-triggers.ts";
import { triggerConditionLayer } from "../../src/trigger-condition.ts";
import { BrainSpec } from "@usine/core/agent/brain";
import { layer as localWorkerLayer } from "../../src/local.ts";

const PositiveIntFromString = Schema.FiniteFromString.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
);

const GitHubComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.NullOr(Schema.String),
  user: Schema.Struct({ login: Schema.String }),
});
const GitHubComments = Schema.Array(GitHubComment);

const repositoryApi = (repository: RepositoryName): string =>
  `https://api.github.com/repos/${repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;

const requestJson = Effect.fn("agentIntegration.requestJson")(function* <A>(options: {
  readonly body?: Schema.Json;
  readonly expectedStatus: number;
  readonly method?: string;
  readonly schema: Schema.Codec<A, unknown, never>;
  readonly token: string;
  readonly url: string;
}) {
  const init: RequestInit = {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2026-03-10",
    },
  };
  if (options.method !== undefined) init.method = options.method;
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = yield* Effect.tryPromise(() => fetch(options.url, init));
  if (response.status !== options.expectedStatus) {
    const detail = yield* Effect.tryPromise(() => response.text());
    return yield* Effect.die(
      `GitHub returned ${response.status} for ${options.method ?? "GET"} ${options.url}: ${detail}`,
    );
  }
  const value = yield* Effect.tryPromise(() => response.json());
  return yield* Schema.decodeUnknownEffect(options.schema)(value);
});

const requestEmpty = Effect.fn("agentIntegration.requestEmpty")(function* (options: {
  readonly expectedStatus: number;
  readonly method: string;
  readonly token: string;
  readonly url: string;
}) {
  const response = yield* Effect.tryPromise(() =>
    fetch(options.url, {
      method: options.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": "2026-03-10",
      },
    }),
  );
  if (response.status !== options.expectedStatus) {
    const detail = yield* Effect.tryPromise(() => response.text());
    return yield* Effect.die(
      `GitHub returned ${response.status} for ${options.method} ${options.url}: ${detail}`,
    );
  }
});

const makeInstance = (options: {
  readonly childModel: ModelId;
  readonly issueNumber: number;
  readonly kick: string;
  readonly marker: string;
  readonly parentModel: ModelId;
  readonly repository: RepositoryName;
}): LoadedInstance => {
  const config = Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [{ name: options.repository, tags: ["integration"] }],
    settings: { parent_model: options.parentModel, poll_interval: 15 },
    workers: [{ name: "local", kind: "local", max_concurrent_attempts: 1 }],
  });
  const agent = new AgentFile({
    name: AgentName.make("live-contract-agent"),
    harness: "claude",
    model: options.childModel,
    effort: "low",
    parentModel: Option.none(),
    parentEffort: Option.none(),
    persona: AgentPersona.make(
      "Act conservatively. Perform only the requested GitHub operation and report its result.",
    ),
  });
  const loop = new LoopFile({
    name: LoopName.make("live-agent-contract"),
    trigger: new IssueTrigger({
      on: "issue",
      if: Source.make(
        `item.number == ${String(options.issueNumber)} && item.comments.nodes.exists(comment, comment.body == ${JSON.stringify(options.kick)})`,
      ),
    }),
    selector: Option.some(
      new Selector({ repos: Option.some([options.repository]), tags: Option.none() }),
    ),
    approval: "none",
    step: StepName.make("comment"),
    agent: agent.name,
    body: PromptTemplate.make(
      [
        "Use the subagent tool exactly once and delegate this entire task to that child.",
        `The child must use \`gh issue view ${String(options.issueNumber)} --repo ${options.repository}\` to read the issue before acting.`,
        `Then it must post exactly one comment on issue #${String(options.issueNumber)} containing these two lines:`,
        options.marker,
        "Issue title: {{ item.title }}",
        "Do not modify files, branches, labels, or any other GitHub state.",
      ].join("\n"),
    ),
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

const runtimeLayer = (
  credentialsDirectory: InstanceDirectory,
  runtimeDirectory: InstanceDirectory,
  instance: LoadedInstance,
) => {
  const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  const app = GitHubApp.layer.pipe(
    Layer.provide(localSecretsLayer(credentialsDirectory).pipe(Layer.provide(platform))),
    Layer.provide(FetchHttpClient.layer),
  );
  const credentials = gitHubCredentialLayer(instance.config).pipe(Layer.provide(app));
  const polling = GitHubPolling.layer.pipe(
    Layer.provide(app),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );
  const triggerCondition = triggerConditionLayer(instance).pipe(
    Layer.provide(polling),
    Layer.provide(MarcbachmannCelLayer),
  );
  const engine = localWorkerLayer(
    runtimeDirectory,
    instance.config,
    instance.agents.map(({ harness, model, effort }) => new BrainSpec({ harness, model, effort })),
    {
      interruptGrace: "10 seconds",
    },
  ).pipe(Layer.provide(credentials), Layer.provide(triggerCondition));
  const labelWriter = GitHubLabelWriter.layer.pipe(
    Layer.provide(app),
    Layer.provide(FetchHttpClient.layer),
  );
  const labelReconciler = LabelReconciler.layer.pipe(Layer.provide(labelWriter));
  const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
  const dependencies = Layer.mergeAll(
    app,
    engine,
    labelReconciler,
    MarcbachmannCelLayer,
    parser,
    polling,
  );
  return Layer.merge(dependencies, PollingTriggers.layer.pipe(Layer.provide(dependencies)));
};

const waitForClaim = Effect.fn("agentIntegration.waitForClaim")(function* (
  polling: PollingTriggers["Service"],
  instance: LoadedInstance,
) {
  for (let poll = 0; poll < instance.config.settings.pollInterval; poll += 1) {
    const cycle = yield* polling.poll(instance);
    if (cycle.failures.length > 0) {
      return yield* Effect.die(
        `Polling failed: ${cycle.failures.map(({ errorTag, message }) => `${errorTag}: ${message}`).join("; ")}`,
      );
    }
    const claimed = cycle.submissions.find(
      (
        submission,
      ): submission is Extract<(typeof cycle.submissions)[number], { _tag: "Claimed" }> =>
        submission._tag === "Claimed",
    );
    if (claimed !== undefined) return claimed.runId;
    yield* Effect.sleep("1 second");
  }
  return yield* Effect.die("The changed issue did not produce a live agent Run");
});

const waitForTerminal = Effect.fn("agentIntegration.waitForTerminal")(function* (
  engine: RunEngine["Service"],
  runId: RunId,
) {
  for (let poll = 0; poll < 600; poll += 1) {
    const snapshot = yield* engine.inspect(runId);
    if (["Succeeded", "Failed", "Canceled"].includes(snapshot.run.state._tag)) return snapshot;
    yield* Effect.sleep("1 second");
  }
  return yield* Effect.die(`Live agent Run ${runId} did not finish within ten minutes`);
});

describe("live agent loop", () => {
  it.live(
    "reads an issue and comments as the App bot with the Agent signature",
    () =>
      Effect.gen(function* () {
        const settings = yield* Effect.all({
          botLogin: Config.string("USINE_GITHUB_INTEGRATION_BOT_LOGIN"),
          childModel: Config.string("USINE_AGENT_INTEGRATION_CHILD_MODEL"),
          credentialsDirectory: Config.string("USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY"),
          issueNumber: Config.schema(
            PositiveIntFromString,
            "USINE_GITHUB_INTEGRATION_ISSUE_NUMBER",
          ),
          parentModel: Config.string("USINE_AGENT_INTEGRATION_PARENT_MODEL"),
          repository: Config.string("USINE_GITHUB_INTEGRATION_REPO"),
        });
        const repository = RepositoryName.make(settings.repository);
        const marker = `usine live agent contract ${globalThis.crypto.randomUUID()}`;
        const kick = `usine live agent kick ${globalThis.crypto.randomUUID()}`;
        const instance = makeInstance({
          childModel: ModelId.make(settings.childModel),
          issueNumber: settings.issueNumber,
          kick,
          marker,
          parentModel: ModelId.make(settings.parentModel),
          repository,
        });
        const fileSystem = yield* FileSystem.FileSystem;
        const runtimeDirectory = InstanceDirectory.make(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-live-agent-" }),
        );
        const credentialsDirectory = InstanceDirectory.make(settings.credentialsDirectory);
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const context = yield* Scope.provide(
          Layer.build(runtimeLayer(credentialsDirectory, runtimeDirectory, instance)),
          scope,
        );
        const app = Context.get(context, GitHubApp);
        const engine = Context.get(context, RunEngine);
        const polling = Context.get(context, PollingTriggers);
        const api = repositoryApi(repository);
        const installationToken = yield* app.installationToken();
        const token = Redacted.value(installationToken.value);

        const listComments = () =>
          requestJson({
            expectedStatus: 200,
            schema: GitHubComments,
            token,
            url: `${api}/issues/${String(settings.issueNumber)}/comments?per_page=100`,
          });
        const removeTestComments = Effect.gen(function* () {
          const comments = yield* listComments();
          yield* Effect.forEach(
            comments.filter(
              ({ body }) => body?.includes(marker) === true || body?.includes(kick) === true,
            ),
            ({ id }) =>
              requestEmpty({
                expectedStatus: 204,
                method: "DELETE",
                token,
                url: `${api}/issues/comments/${String(id)}`,
              }),
            { concurrency: "unbounded", discard: true },
          );
        });

        yield* Effect.acquireUseRelease(
          Effect.succeed(undefined),
          () =>
            Effect.gen(function* () {
              yield* polling.poll(instance);
              yield* requestJson({
                body: { body: kick },
                expectedStatus: 201,
                method: "POST",
                schema: GitHubComment,
                token,
                url: `${api}/issues/${String(settings.issueNumber)}/comments`,
              });
              const runId = yield* waitForClaim(polling, instance);
              const snapshot = yield* waitForTerminal(engine, runId);
              assert.strictEqual(
                snapshot.run.state._tag,
                "Succeeded",
                `live Run ended ${snapshot.run.state._tag}: ${snapshot.attempts
                  .map((attempt) =>
                    Option.match(attempt.outcome, {
                      onNone: () => "open",
                      onSome: (outcome) =>
                        outcome._tag === "Failed"
                          ? `${outcome.failure._tag}: ${outcome.failure.message}`
                          : outcome._tag,
                    }),
                  )
                  .join("; ")}`,
              );
              const attempt = snapshot.attempts[0] ?? assert.fail("live Run recorded no Attempt");
              assert.strictEqual(attempt.brain.harness, "claude");
              assert.strictEqual(attempt.brain.model, settings.childModel);
              assert.strictEqual(attempt.brain.effort, "low");
              assert(Option.isSome(attempt.parentModel));
              assert.strictEqual(attempt.parentModel.value, settings.parentModel);
              const payload = Schema.decodeUnknownSync(IssuePayload)(snapshot.event.payload);

              const comments = (yield* listComments()).filter(
                ({ body }) => body?.includes(marker) === true,
              );
              assert.strictEqual(
                comments.length,
                1,
                "the child must post exactly one result comment",
              );
              const comment = comments[0] ?? assert.fail("missing live contract comment");
              assert.strictEqual(comment.user.login, settings.botLogin);
              assert(
                comment.body?.includes(`Issue title: ${payload.title}`),
                "the result comment must contain the CEL-interpolated issue title",
              );
              assert.match(comment.body ?? "", /— usine agent: live-contract-agent/u);

              const transcript = yield* engine.transcript(
                new TranscriptAllQuery({ attemptId: attempt.id }),
              );
              assert(
                transcript.some(
                  ({ envelope }) =>
                    envelope.payload._tag === "SessionEvent" &&
                    envelope.payload.event.session._tag === "ChildSession",
                ),
                "the transcript must expose child session events one level deep",
              );
            }),
          () => removeTestComments,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    // The run spans a poll claim plus a full agent session; the terminal wait
    // inside the test caps it at ten minutes.
    720_000,
  );
});
