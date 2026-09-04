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
import { Repository, Step } from "@usine/core";
import { Source } from "@usine/expression";
import {
  GitHubApiError,
  GitHubLabelWriter,
  GitHubPolling,
  GitHubRateLimitError,
  RepositoryLabel,
  RepositoryLabelCatalog,
  RepositoryLabelColor,
  RepositoryNotModified,
} from "@usine/github";
import { DateTime, Effect, Option, Schema } from "effect";
import { PollingTriggers } from "../src/index.ts";
import { pollingTestLayer } from "./support/polling.ts";

const repository = Repository.Name.make("basaltbytes/usine");
const agent = new AgentFile({
  name: AgentName.make("developer"),
  harness: "codex",
  model: ModelId.make("gpt-5.6-sol"),
  effort: "high",
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: Persona.make("Implement the issue."),
});
const loop = new LoopFile({
  name: LoopName.make("start-dev"),
  trigger: new IssueTrigger({ on: "issue", if: Source.make("true") }),
  selector: Option.some(new Selector({ repos: Option.some([repository]), tags: Option.none() })),
  approval: "required",
  step: Step.StepName.make("run"),
  agent: agent.name,
  body: PromptTemplate.make("Implement it."),
});
const config = Schema.decodeUnknownSync(UsineConfig)({
  version: 1,
  labels: [{ name: "ready", color: "A2EEEF" }],
  repos: [{ name: repository }],
});
const instance = new LoadedInstance({
  config,
  agents: [agent],
  invalidAgents: [],
  loops: [loop],
  quarantinedLoops: [],
  warnings: [],
});
const emptyCatalog = new RepositoryLabelCatalog({
  entityTag: Option.none(),
  labels: [],
});

describe("PollingTriggers label preflight", () => {
  it.effect("creates declarations before the first repository change poll", () => {
    const operations: Array<string> = [];
    const github: GitHubPolling["Service"] = {
      labels: () =>
        Effect.sync(() => {
          operations.push("catalog");
          return emptyCatalog;
        }),
      changes: (_repository, cursor) =>
        Effect.sync(() => {
          operations.push("changes");
          return new RepositoryNotModified({ cursor, nextPollAt: Option.none() });
        }),
      snapshot: () => Effect.die("an unchanged repository has no snapshots"),
    };
    const writer: GitHubLabelWriter["Service"] = {
      create: (_repository, label) =>
        Effect.sync(() => {
          operations.push(`create:${label.name}`);
          return new RepositoryLabel({
            name: label.name,
            color: Option.getOrElse(label.color, () => RepositoryLabelColor.make("ededed")),
            description: label.description,
          });
        }),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instance);

      assert.deepStrictEqual(operations, ["catalog", "create:ready", "changes"]);
      assert.deepStrictEqual(cycle.preflightFindings, []);
    }).pipe(Effect.provide(pollingTestLayer(github, [], writer)));
  });

  it.effect("continues change detection after a declaration cannot be created", () => {
    const operations: Array<string> = [];
    const github: GitHubPolling["Service"] = {
      labels: () => Effect.succeed(emptyCatalog),
      changes: (_repository, cursor) =>
        Effect.sync(() => {
          operations.push("changes");
          return new RepositoryNotModified({ cursor, nextPollAt: Option.none() });
        }),
      snapshot: () => Effect.die("an unchanged repository has no snapshots"),
    };
    const writer: GitHubLabelWriter["Service"] = {
      create: () =>
        Effect.sync(() => operations.push("create")).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new GitHubApiError({
                operation: "create-repository-label",
                status: Option.some(500),
                message: "GitHub rejected the request with status 500",
              }),
            ),
          ),
        ),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instance);

      assert.deepStrictEqual(operations, ["create", "changes"]);
      assert.deepStrictEqual(
        cycle.preflightFindings.map(({ label }) => label),
        ["ready"],
      );
    }).pipe(Effect.provide(pollingTestLayer(github, [], writer)));
  });

  it.effect("preserves creation findings when change detection is later rate-limited", () => {
    const creationRetryAt = DateTime.makeUnsafe("2026-09-03T12:01:00Z");
    const changesRetryAt = DateTime.makeUnsafe("2026-09-03T12:02:00Z");
    const github: GitHubPolling["Service"] = {
      labels: () => Effect.succeed(emptyCatalog),
      changes: () =>
        Effect.fail(
          new GitHubRateLimitError({
            operation: "poll-repository-changes",
            retryAt: changesRetryAt,
            message: "change polling rate-limited",
          }),
        ),
      snapshot: () => Effect.die("change detection did not return any items"),
    };
    const writer: GitHubLabelWriter["Service"] = {
      create: () =>
        Effect.fail(
          new GitHubRateLimitError({
            operation: "create-repository-label",
            retryAt: creationRetryAt,
            message: "label creation rate-limited",
          }),
        ),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instance);

      assert.deepStrictEqual(
        cycle.preflightFindings.map(({ label }) => label),
        ["ready"],
      );
      assert(Option.isSome(cycle.nextPollAt));
      assert.strictEqual(
        DateTime.toEpochMillis(cycle.nextPollAt.value),
        DateTime.toEpochMillis(changesRetryAt),
      );
    }).pipe(Effect.provide(pollingTestLayer(github, [], writer)));
  });
});
