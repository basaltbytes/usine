import { InvalidGitHubResponseError } from "@usine/github/github-app";
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
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schema,
  SubscriptionRef,
} from "effect";
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
const installation = Installation.make({
  id: InstallationId.make(77),
  accountLogin: "basaltbytes",
  appSlug: AppSlug.make("usine-test"),
});
const project = CoveredProject.make({
  installationId: installation.id,
  repository,
  repositoryId: RepositoryId.make(99),
});
const instance = (mode: "off" | "deliveries") =>
  Effect.gen(function* () {
    return LoadedInstance.make({
      config: yield* Schema.decodeEffect(UsineConfig)({
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
  });
const delivery = (id: string, event: string, repositoryId: number | null) =>
  Schema.decodeEffect(WebhookDelivery)({ id, event, repositoryId }).pipe(
    Effect.mapError((cause) =>
      InvalidGitHubResponseError.make({
        operation: "poll-webhook-deliveries",
        message: "Invalid delivery fixture",
        detail: cause.message,
      }),
    ),
  );

const appLayer = (deliveries: GitHubApp["Service"]["deliveries"]) =>
  Layer.mock(GitHubApp)({
    installation: Effect.succeed(installation),
    projectAccess: () => Effect.succeed([project]),
    deliveries,
  });

describe("Webhook delivery polling", () => {
  it.live.each(["absent", "legacy number"])(
    "persists the exact newest ID and resumes after reopening SQLite with an initially %s cursor",
    (initialCursor) =>
      Effect.gen(function* () {
        const currentDirectory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-deliveries-",
        });
        const directory = InstanceDirectory.make(currentDirectory);
        const hints: Array<RepositoryName> = [];
        const seen: Array<Option.Option<WebhookDeliveryId>> = [];
        const app = appLayer((after) =>
          Effect.gen(function* () {
            seen.push(after);
            return [
              yield* delivery("9", "ping", null),
              yield* delivery("3851199271760044123", "ping", null),
              yield* delivery("3851199271760044122", "issues", 100),
              yield* delivery("3851199271760044121", "issues", 99),
              yield* delivery("3851199271760044120", "pull_request", 99),
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
          }).pipe(
            Effect.provide(CursorStore.layer.pipe(Layer.provideMerge(localSqliteLayer(directory)))),
          );
        }
        const cycle = Effect.gen(function* () {
          const decodedValue9 = yield* instance("deliveries");
          yield* (yield* WebhookDeliveries).poll(decodedValue9);

          const stored = yield* (yield* CursorStore).read(key, Schema.String);
          assert.deepStrictEqual(stored, Option.some("3851199271760044123"));
        }).pipe(
          Effect.provide(
            WebhookDeliveries.layer.pipe(
              Layer.provideMerge(app),
              Layer.provideMerge(polling),
              Layer.provideMerge(CursorStore.layer),
            ),
          ),
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
          Effect.succeed(RepositoryLabelCatalog.make({ entityTag: Option.none(), labels: [] })),
        changes: (_repository, cursor) =>
          Effect.sync(() => {
            requests += 1;
            return RepositoryNotModified.make({ cursor, nextPollAt: Option.none() });
          }),
        snapshot: () => Effect.die("no changed item"),
      };
      const polling = pollingTestLayer(github, [], undefined, undefined, cursors.store);
      const source = WebhookDeliveries.layer.pipe(
        Layer.provideMerge(polling),
        Layer.provide(
          appLayer((after) =>
            Effect.gen(function* () {
              return yield* Effect.succeed(
                Option.isSome(after) ? [] : [yield* delivery("1", "issues", 99)],
              );
            }),
          ),
        ),
        Layer.provide(Layer.succeed(CursorStore)(cursors.store)),
      );
      return Effect.gen(function* () {
        const poller = yield* PollingTriggers;
        const deliveries = yield* WebhookDeliveries;
        const current = yield* instance("deliveries");
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
      const decodedValue8 = yield* instance("off");
      const current = yield* SubscriptionRef.make(decodedValue8);
      const enabled = yield* source
        .run({ get: SubscriptionRef.get(current), changes: SubscriptionRef.changes(current) })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(requests, 0);
      const decodedValue7 = yield* instance("deliveries");
      yield* SubscriptionRef.set(current, decodedValue7);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(requests, 1);
      yield* TestClock.adjust("9999 millis");
      assert.strictEqual(requests, 2);
      const decodedValue6 = yield* instance("off");
      yield* SubscriptionRef.set(current, decodedValue6);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(requests, 2);
      const decodedValue5 = yield* instance("deliveries");
      yield* SubscriptionRef.set(current, decodedValue5);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(requests, 3);
      yield* Fiber.interrupt(enabled);
    }).pipe(
      Effect.provide(
        WebhookDeliveries.layer.pipe(
          Layer.provideMerge(app),
          Layer.provideMerge(Layer.mock(PollingTriggers)({})),
          Layer.provideMerge(Layer.succeed(CursorStore)(memoryCursorStore().store)),
        ),
      ),
    );
  });

  it.effect("honors delivery API rate limits and retries without advancing the cursor", () => {
    const started = Deferred.makeUnsafe<void>();
    let requests = 0;
    const app = appLayer(() =>
      Effect.suspend(() => {
        requests += 1;
        return requests === 1
          ? Effect.fail(
              GitHubRateLimitError.make({
                operation: "poll-webhook-deliveries",
                retryAt: DateTime.makeUnsafe(30000),
                message: "Wait",
              }),
            ).pipe(Effect.tapError(() => Deferred.succeed(started, undefined)))
          : Effect.succeed([]);
      }),
    );
    const cursors = memoryCursorStore();
    return Effect.gen(function* () {
      const source = yield* WebhookDeliveries;
      const decodedValue4 = yield* instance("deliveries");
      const fiber = yield* source.run(fixedInstance(decodedValue4)).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("29999 millis");
      assert.strictEqual(requests, 1);
      assert.strictEqual(cursors.stored.size, 0);
      yield* TestClock.adjust("1 millis");
      assert.strictEqual(requests, 2);
      yield* Fiber.interrupt(fiber);
    }).pipe(
      Effect.provide(
        WebhookDeliveries.layer.pipe(
          Layer.provideMerge(app),
          Layer.provideMerge(Layer.mock(PollingTriggers)({})),
          Layer.provideMerge(Layer.succeed(CursorStore)(cursors.store)),
        ),
      ),
    );
  });
});

it.effect(
  "interrupts an in-flight delivery request on a mode revision and resumes hints from its cursor",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const received = yield* Deferred.make<void>();
      const decodedValue3 = yield* instance("deliveries");
      const current = yield* SubscriptionRef.make(decodedValue3);
      const cursors = memoryCursorStore();
      let requests = 0;
      const app = appLayer(() =>
        Effect.suspend(() =>
          Effect.gen(function* () {
            requests += 1;
            return yield* requests === 1
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(stopped, undefined)),
                )
              : Effect.succeed([yield* delivery("42", "issues", 99)]);
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const source = yield* WebhookDeliveries;
        const running = yield* source
          .run({ get: SubscriptionRef.get(current), changes: SubscriptionRef.changes(current) })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const decodedValue2 = yield* instance("off");
        yield* SubscriptionRef.set(current, decodedValue2);
        yield* Deferred.await(stopped);
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(requests, 1);
        const decodedValue1 = yield* instance("deliveries");
        yield* SubscriptionRef.set(current, decodedValue1);
        yield* Deferred.await(received);
        yield* TestClock.adjust("1 millis");
        assert.strictEqual(requests, 2);
        const snapshot = yield* cursors.store.read(
          CursorKey.make(`github-deliveries:${installation.id}`),
          WebhookDeliveryId,
        );
        assert.deepStrictEqual(snapshot, Option.some(WebhookDeliveryId.make("42")));
        yield* Fiber.interrupt(running);
      }).pipe(
        Effect.provide(
          WebhookDeliveries.layer.pipe(
            Layer.provideMerge(app),
            Layer.provideMerge(
              Layer.mock(PollingTriggers)({
                hint: (hinted) => {
                  assert.strictEqual(hinted, repository);
                  return Deferred.succeed(received, undefined).pipe(Effect.asVoid);
                },
              }),
            ),
            Layer.provideMerge(Layer.succeed(CursorStore, cursors.store)),
          ),
        ),
      );
    }),
);
