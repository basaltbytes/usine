import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { InstanceDirectory } from "@usine/core/instance";
import { RepositoryName } from "@usine/core/repository";
import { CursorKey, CursorStore } from "@usine/engine/cursor";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import {
  AppSlug,
  CoveredProject,
  GitHubApp,
  GitHubRateLimitError,
  Installation,
  InstallationId,
  RepositoryId,
  WebhookDelivery,
  WebhookDeliveryId,
} from "@usine/github/github-app";
import { DateTime, Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { WebhookDeliveries } from "../src/polling/deliveries.ts";
import { PollingTriggers } from "../src/polling-triggers.ts";
import { fixedInstance } from "./support/current-instance.ts";
import {
  GitHubPolling,
  RepositoryNotModified,
  RepositoryLabelCatalog,
} from "@usine/github/polling";
import { memoryCursorStore, pollingTestLayer, unmovedBaseRefHead } from "./support/polling.ts";

const repository = RepositoryName.make("basaltbytes/usine");
const installation = new Installation({
  id: InstallationId.make(77),
  accountLogin: "basaltbytes",
  appSlug: AppSlug.make("usine-test"),
});
const project = new CoveredProject({
  installationId: installation.id,
  repository,
  repositoryId: RepositoryId.make(99),
});
const instance = (mode: "off" | "deliveries") =>
  new LoadedInstance({
    config: Schema.decodeUnknownSync(UsineConfig)({
      version: 1,
      repos: [{ name: repository }],
      webhooks: { mode },
    }),
    agents: [],
    loops: [],
    invalidAgents: [],
    quarantinedLoops: [],
    warnings: [],
  });
const delivery = (id: string, event: string, repositoryId: number | null) =>
  Schema.decodeUnknownSync(WebhookDelivery)({ id, event, repositoryId });

const appLayer = (deliveries: GitHubApp["Service"]["deliveries"]) =>
  Layer.mock(GitHubApp)({
    installation: () => Effect.succeed(installation),
    projectAccess: () => Effect.succeed([project]),
    deliveries,
  });

describe("Webhook delivery polling", () => {
  it.live.each(["absent", "legacy number"])(
    "persists the exact newest ID and resumes after reopening SQLite with an initially %s cursor",
    (initialCursor) =>
      Effect.gen(function* () {
        const directory = InstanceDirectory.make(
          yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
            directory: sqliteTempDirectory(),
            prefix: "usine-deliveries-",
          }),
        );
        const hints: Array<RepositoryName> = [];
        const seen: Array<Option.Option<WebhookDeliveryId>> = [];
        const app = appLayer((after) =>
          Effect.sync(() => {
            seen.push(after);
            return [
              delivery("9", "ping", null),
              delivery("3851199271760044123", "ping", null),
              delivery("3851199271760044122", "issues", 100),
              delivery("3851199271760044121", "issues", 99),
              delivery("3851199271760044120", "pull_request", 99),
            ].filter(({ id }) => Option.isNone(after) || BigInt(id) > BigInt(after.value));
          }),
        );
        const polling = Layer.mock(PollingTriggers)({
          hint: (name) =>
            Effect.sync(() => {
              hints.push(name);
            }),
        });
        const key = CursorKey.make(`github-deliveries:${installation.id}`);
        if (initialCursor === "legacy number") {
          yield* Effect.gen(function* () {
            yield* (yield* CursorStore).write(key, Schema.Int, 9);
          }).pipe(Effect.provide(CursorStore.layer), Effect.provide(localSqliteLayer(directory)));
        }
        const cycle = Effect.gen(function* () {
          yield* (yield* WebhookDeliveries).poll(instance("deliveries"));
          const stored = yield* (yield* CursorStore).read(key, Schema.String);
          assert.deepStrictEqual(stored, Option.some("3851199271760044123"));
        }).pipe(
          Effect.provide(WebhookDeliveries.layer),
          Effect.provide(app),
          Effect.provide(polling),
          Effect.provide(CursorStore.layer),
        );
        yield* cycle.pipe(Effect.provide(localSqliteLayer(directory)));
        assert.deepStrictEqual(hints, [repository]);
        yield* cycle.pipe(Effect.provide(localSqliteLayer(directory)));
        assert.deepStrictEqual(hints, [repository]);
        assert.deepStrictEqual(seen, [
          Option.none(),
          Option.some(WebhookDeliveryId.make("3851199271760044123")),
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "refreshes a delivered repository once through change detection before the backstop",
    () => {
      let requests = 0;
      const cursors = memoryCursorStore();
      const github: GitHubPolling["Service"] = {
        baseRefHead: unmovedBaseRefHead,
        missingIssues: () => Effect.succeed([]),
        labels: () =>
          Effect.succeed(new RepositoryLabelCatalog({ entityTag: Option.none(), labels: [] })),
        changes: (_repository, cursor) =>
          Effect.sync(() => {
            requests += 1;
            return new RepositoryNotModified({ cursor, nextPollAt: Option.none() });
          }),
        snapshot: () => Effect.die("no changed item"),
      };
      const polling = pollingTestLayer(github, [], undefined, undefined, cursors.store);
      const source = WebhookDeliveries.layer.pipe(
        Layer.provideMerge(polling),
        Layer.provide(
          appLayer((after) =>
            Effect.succeed(Option.isSome(after) ? [] : [delivery("1", "issues", 99)]),
          ),
        ),
        Layer.provide(Layer.succeed(CursorStore)(cursors.store)),
      );
      return Effect.gen(function* () {
        const poller = yield* PollingTriggers;
        const deliveries = yield* WebhookDeliveries;
        const current = instance("deliveries");
        const fiber = yield* poller.run(fixedInstance(current)).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 millis");
        assert.strictEqual(requests, 1);
        yield* deliveries.poll(current);
        yield* TestClock.adjust("1 millis");
        assert.strictEqual(requests, 2);
        yield* deliveries.poll(current);
        yield* TestClock.adjust("59997 millis");
        assert.strictEqual(requests, 2);
        yield* TestClock.adjust("1 millis");
        assert.strictEqual(requests, 3);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(source));
    },
  );

  it.effect("keeps deliveries off by default and polls every ten seconds when enabled", () => {
    let requests = 0;
    const app = appLayer(() =>
      Effect.sync(() => {
        requests += 1;
        return [];
      }),
    );
    return Effect.gen(function* () {
      const source = yield* WebhookDeliveries;
      const off = yield* source.run(fixedInstance(instance("off"))).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(requests, 0);
      yield* Fiber.interrupt(off);
      const enabled = yield* source
        .run(fixedInstance(instance("deliveries")))
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(requests, 1);
      yield* TestClock.adjust("9999 millis");
      assert.strictEqual(requests, 2);
      yield* Fiber.interrupt(enabled);
    }).pipe(
      Effect.provide(WebhookDeliveries.layer),
      Effect.provide(app),
      Effect.provide(Layer.mock(PollingTriggers)({})),
      Effect.provide(Layer.succeed(CursorStore)(memoryCursorStore().store)),
    );
  });

  it.effect("honors delivery API rate limits and retries without advancing the cursor", () => {
    let requests = 0;
    const app = appLayer(() =>
      Effect.suspend(() => {
        requests += 1;
        return requests === 1
          ? Effect.fail(
              new GitHubRateLimitError({
                operation: "poll-webhook-deliveries",
                retryAt: DateTime.makeUnsafe(30_000),
                message: "Wait",
              }),
            )
          : Effect.succeed([]);
      }),
    );
    const cursors = memoryCursorStore();
    return Effect.gen(function* () {
      const source = yield* WebhookDeliveries;
      const fiber = yield* source.run(fixedInstance(instance("deliveries"))).pipe(Effect.forkChild);
      yield* TestClock.adjust("29999 millis");
      assert.strictEqual(requests, 1);
      assert.strictEqual(cursors.stored.size, 0);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(requests, 2);
      yield* Fiber.interrupt(fiber);
    }).pipe(
      Effect.provide(WebhookDeliveries.layer),
      Effect.provide(app),
      Effect.provide(Layer.mock(PollingTriggers)({})),
      Effect.provide(Layer.succeed(CursorStore)(cursors.store)),
    );
  });
});
