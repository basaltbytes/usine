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
import {
  RepositoryLabel as StoredRepositoryLabel,
  RepositoryLabelProjection,
  RepositoryLabelProjectionReader,
} from "@usine/engine";
import { Source } from "@usine/expression";
import {
  EntityTag,
  GitHubApiError,
  GitHubLabelWriter,
  GitHubPolling,
  GitHubRateLimitError,
  RepositoryLabel,
  RepositoryLabelCatalog,
  RepositoryLabelColor,
  RepositoryLabelName,
  RepositoryLabelsNotModified,
  RepositoryNotModified,
} from "@usine/github";
import { DateTime, Effect, Option, Schema } from "effect";
import { PollingTriggers } from "../src/index.ts";
import { memoryCursorStore, pollingTestLayer } from "./support/polling.ts";

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
const catalogEntityTag = EntityTag.make('W/"labels"');
const StoredCatalogEntityTag = Schema.Struct({ labelEntityTag: Schema.NullOr(Schema.String) });
const decodeStoredCatalogEntityTag = Schema.decodeUnknownSync(StoredCatalogEntityTag);
/** The catalog ETag each persisted poll cursor will send next cycle. */
const storedCatalogEntityTags = (
  stored: ReadonlyMap<string, Schema.Json>,
): ReadonlyArray<string | null> =>
  [...stored.values()].map((cursor) => decodeStoredCatalogEntityTag(cursor).labelEntityTag);

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

  it.effect("defers provisioning when the first catalog request fails", () => {
    const operations: Array<string> = [];
    const github: GitHubPolling["Service"] = {
      labels: () =>
        Effect.fail(
          new GitHubApiError({
            operation: "list-repository-labels",
            status: Option.some(502),
            message: "GitHub rejected the request with status 502",
          }),
        ),
      changes: (_repository, cursor) =>
        Effect.sync(() => {
          operations.push("changes");
          return new RepositoryNotModified({ cursor, nextPollAt: Option.none() });
        }),
      snapshot: () => Effect.die("an unchanged repository has no snapshots"),
    };
    const writer: GitHubLabelWriter["Service"] = {
      create: (_repository, label) =>
        Effect.die(`no catalog was confirmed, so ${label.name} must not be created`),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instance);

      assert.deepStrictEqual(operations, ["changes"]);
      assert.deepStrictEqual(cycle.preflightFindings, []);
      assert.deepStrictEqual(
        cycle.failures.map(({ errorTag }) => errorTag),
        ["GitHubApiError"],
      );
    }).pipe(Effect.provide(pollingTestLayer(github, [], writer)));
  });

  it.effect("keeps the failed catalog request visible when change detection also fails", () => {
    const github: GitHubPolling["Service"] = {
      labels: () =>
        Effect.fail(
          new GitHubApiError({
            operation: "list-repository-labels",
            status: Option.some(502),
            message: "catalog request failed",
          }),
        ),
      changes: () =>
        Effect.fail(
          new GitHubApiError({
            operation: "poll-repository-changes",
            status: Option.some(500),
            message: "change detection failed",
          }),
        ),
      snapshot: () => Effect.die("change detection did not return any items"),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instance);

      assert.deepStrictEqual(
        cycle.failures.map(({ message }) => message),
        ["catalog request failed", "change detection failed"],
      );
      assert.deepStrictEqual(cycle.preflightFindings, []);
    }).pipe(Effect.provide(pollingTestLayer(github)));
  });

  it.effect("defers provisioning while the catalog request is rate-limited", () => {
    const retryAt = DateTime.makeUnsafe("2026-09-03T12:03:00Z");
    const github: GitHubPolling["Service"] = {
      labels: () =>
        Effect.fail(
          new GitHubRateLimitError({
            operation: "list-repository-labels",
            retryAt,
            message: "catalog rate-limited",
          }),
        ),
      changes: (_repository, cursor) =>
        Effect.succeed(new RepositoryNotModified({ cursor, nextPollAt: Option.none() })),
      snapshot: () => Effect.die("an unchanged repository has no snapshots"),
    };
    const writer: GitHubLabelWriter["Service"] = {
      create: (_repository, label) =>
        Effect.die(`the catalog is backing off, so ${label.name} must not be created`),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instance);

      assert.deepStrictEqual(cycle.preflightFindings, []);
      assert(Option.isSome(cycle.nextPollAt));
      assert.strictEqual(
        DateTime.toEpochMillis(cycle.nextPollAt.value),
        DateTime.toEpochMillis(retryAt),
      );
    }).pipe(Effect.provide(pollingTestLayer(github, [], writer)));
  });

  it.effect("reconciles against the stored catalog when GitHub reports it unchanged", () => {
    const operations: Array<string> = [];
    const github: GitHubPolling["Service"] = {
      labels: () => Effect.succeed(new RepositoryLabelsNotModified()),
      changes: (_repository, cursor) =>
        Effect.succeed(new RepositoryNotModified({ cursor, nextPollAt: Option.none() })),
      snapshot: () => Effect.die("an unchanged repository has no snapshots"),
    };
    const writer: GitHubLabelWriter["Service"] = {
      create: (_repository, label) =>
        Effect.die(`${label.name} is already stored, so it must not be created again`),
    };
    const storedProjections: RepositoryLabelProjectionReader["Service"] = {
      get: (name) =>
        Effect.sync(() => {
          operations.push("projection");
          return Option.some(
            new RepositoryLabelProjection({
              repository: name,
              labels: [
                new StoredRepositoryLabel({
                  name: "ready",
                  color: Option.some("a2eeef"),
                  description: Option.none(),
                }),
              ],
            }),
          );
        }),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instance);

      assert.deepStrictEqual(operations, ["projection"]);
      assert.deepStrictEqual(cycle.preflightFindings, []);
      assert.deepStrictEqual(cycle.failures, []);
    }).pipe(Effect.provide(pollingTestLayer(github, [], writer, storedProjections)));
  });

  it.effect("drops the catalog ETag from the cursor after creating a declaration", () => {
    const cursors = memoryCursorStore();
    const github: GitHubPolling["Service"] = {
      labels: () =>
        Effect.succeed(
          new RepositoryLabelCatalog({ entityTag: Option.some(catalogEntityTag), labels: [] }),
        ),
      changes: (_repository, cursor) =>
        Effect.succeed(new RepositoryNotModified({ cursor, nextPollAt: Option.none() })),
      snapshot: () => Effect.die("an unchanged repository has no snapshots"),
    };
    const writer: GitHubLabelWriter["Service"] = {
      create: (_repository, label) =>
        Effect.succeed(
          new RepositoryLabel({
            name: label.name,
            color: Option.getOrElse(label.color, () => RepositoryLabelColor.make("ededed")),
            description: label.description,
          }),
        ),
    };

    return Effect.gen(function* () {
      const polling = yield* PollingTriggers;
      const cycle = yield* polling.poll(instance);

      assert.deepStrictEqual(cycle.preflightFindings, []);
      // The creation invalidated GitHub's ETag: the next cycle must refetch the catalog.
      assert.deepStrictEqual(storedCatalogEntityTags(cursors.stored), [null]);
    }).pipe(Effect.provide(pollingTestLayer(github, [], writer, undefined, cursors.store)));
  });

  it.effect(
    "refetches the catalog when GitHub reports it unchanged but its projection is gone",
    () => {
      const cursors = memoryCursorStore();
      const catalogRequests: Array<string> = [];
      const github: GitHubPolling["Service"] = {
        labels: (_repository, entityTag) =>
          Effect.sync(() => {
            catalogRequests.push(Option.getOrElse(entityTag, () => "none"));
            return catalogRequests.length === 1
              ? new RepositoryLabelCatalog({
                  entityTag: Option.some(catalogEntityTag),
                  labels: [
                    new RepositoryLabel({
                      name: RepositoryLabelName.make("ready"),
                      color: RepositoryLabelColor.make("a2eeef"),
                      description: Option.none(),
                    }),
                  ],
                })
              : new RepositoryLabelsNotModified();
          }),
        changes: (_repository, cursor) =>
          Effect.succeed(new RepositoryNotModified({ cursor, nextPollAt: Option.none() })),
        snapshot: () => Effect.die("an unchanged repository has no snapshots"),
      };
      const writer: GitHubLabelWriter["Service"] = {
        create: (_repository, label) =>
          Effect.die(`${label.name} already exists, so it must not be created`),
      };

      return Effect.gen(function* () {
        const polling = yield* PollingTriggers;
        yield* polling.poll(instance);
        assert.deepStrictEqual(storedCatalogEntityTags(cursors.stored), [catalogEntityTag]);

        // The projection reader knows nothing: the stored catalog vanished behind the ETag.
        const cycle = yield* polling.poll(instance);

        assert.deepStrictEqual(catalogRequests, ["none", catalogEntityTag]);
        assert.deepStrictEqual(cycle.preflightFindings, []);
        assert.deepStrictEqual(cycle.failures, []);
        assert.deepStrictEqual(storedCatalogEntityTags(cursors.stored), [null]);
      }).pipe(Effect.provide(pollingTestLayer(github, [], writer, undefined, cursors.store)));
    },
  );

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
