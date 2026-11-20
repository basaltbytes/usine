import { jsonKey } from "@usine/core/json-key";
import { assert, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import {
  InstanceScope,
  PermissionGrant,
  ProjectScope,
  administratorPermissions,
} from "@usine/core/access";
import {
  ChangeBus,
  changeBusLayer,
  type ChangeAudience,
  type ChangeTarget,
} from "@usine/core/changes";
import { ProjectId } from "@usine/core/project";
import { RepositoryName } from "@usine/core/repository";
import { LoopName } from "@usine/core/loop";
import { CurrentInstance } from "@usine/orchestrator/current-instance";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Schema, Scope, Stream } from "effect";
import { HttpServerRequest } from "effect/http";
import { TestClock } from "effect/testing";
import { FactoryBackend } from "../src/backend.ts";
import { ChangeAccess } from "../src/changes/access.ts";
import { AuthError } from "../src/auth/model.ts";
import { Changes } from "../src/changes/changes.ts";

const unused = () => Effect.die("unexpected backend read");
const project = ProjectId.make("visible");
const repository = RepositoryName.make("owner/visible");
const config = Schema.decodeEffect(UsineConfig)({
  version: 2,
  projects: [
    { id: project, name: "Visible", repositories: [repository] },
    { id: "hidden", name: "Hidden", repositories: ["owner/hidden"] },
  ],
  repos: [
    { name: repository, tags: [] },
    { name: RepositoryName.make("owner/hidden"), tags: [] },
  ],
});
const instance = Effect.gen(function* () {
  const fixtureConfig = yield* config;
  return LoadedInstance.make({
    config: fixtureConfig,
    agents: [],
    loops: [],
    invalidAgents: [],
    quarantinedLoops: [],
    warnings: [],
  });
});
const instances = Effect.gen(function* () {
  const fixtureInstance = yield* instance;
  return Layer.succeed(CurrentInstance)({
    get: Effect.succeed(fixtureInstance),
    changes: Stream.never,
    reload: unused(),
    commit: unused,
    writes: Effect.succeed([]),
    registerWorkers: () => Effect.void,
  });
});
const request = (cursor?: number | string) =>
  HttpServerRequest.fromWeb(
    new Request("http://localhost/api/changes", {
      headers: cursor === undefined ? {} : { "last-event-id": String(cursor) },
    }),
  );
const open = (cursor?: number | string, grants = administratorPermissions) =>
  Effect.gen(function* () {
    const response = yield* (yield* Changes).stream(request(cursor), grants);
    assert(response.body._tag === "Stream");
    return response.body.stream.pipe(
      Stream.decodeText,
      Stream.catch((cause) =>
        Schema.is(AuthError)(cause) ? Stream.fail(cause) : Stream.die(cause),
      ),
    );
  });
const live = Effect.gen(function* () {
  const fixtureInstances = yield* instances;

  return Changes.layer.pipe(Layer.provide(fixtureInstances));
});

it.effect("keeps a connected stream idle for 30 seconds without reading projections", () =>
  Effect.gen(function* () {
    const reads = { overview: 0, desk: 0, configuration: 0 };
    const failRead = (key: keyof typeof reads) =>
      Effect.sync(() => {
        reads[key]++;
      }).pipe(Effect.andThen(unused()));
    const backend = Layer.succeed(FactoryBackend)({
      overview: failRead("overview"),
      desk: failRead("desk"),
      configuration: failRead("configuration"),
      detail: unused,
      githubChanges: unused,
      approve: unused,
      dismissNeed: unused,
      undoDismissNeed: unused,
      resetCycleBudget: unused,
      resolveFailure: unused,
      applyCiLabels: unused,
      retry: unused,
      agents: unused(),
      editAndRetry: unused,
      runAgain: unused,
      intervene: unused,
      cancel: unused,
      callScope: unused,
      runWorkerPreflight: unused,
      discardLeftovers: unused,
      moveBoardItem: unused,
      pause: unused,
      unpause: unused,
      task: unused,
      brief: unused,
      runText: unused,
      transcriptPage: unused,
      item: unused,
      statistics: unused,
      runStatistics: unused,
    });
    return yield* Effect.gen(function* () {
      const stream = yield* open();
      const fiber = yield* stream.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      const frames = yield* Fiber.join(fiber);
      assert.include(frames[0] ?? "", '"reset":true');
      assert.deepStrictEqual(frames.slice(1), [": heartbeat\n\n", ": heartbeat\n\n"]);
      assert.deepStrictEqual(reads, { overview: 0, desk: 0, configuration: 0 });
    }).pipe(
      Effect.provide(
        (yield* live).pipe(Layer.provideMerge(backend), Layer.provideMerge(changeBusLayer)),
      ),
      Effect.scoped,
    );
  }),
);

it.effect(
  "filters project and instance writes before delivering or replaying their identifiers",
  () =>
    Effect.gen(function* () {
      return yield* Effect.gen(function* () {
        const bus = yield* ChangeBus;
        const initial = yield* bus.open;
        const cases: ReadonlyArray<readonly [ChangeAudience, ChangeTarget]> = [
          [
            { _tag: "Repository", repository },
            { kind: "item", id: "linked-pr" },
          ],
          [
            { _tag: "Loop", loop: LoopName.make("visible/developer") },
            { kind: "run", id: "run" },
          ],
          [ProjectScope.make({ project }), { kind: "attempt", id: "attempt" }],
          [ProjectScope.make({ project }), { kind: "attention", id: "instance" }],
          [ProjectScope.make({ project }), { kind: "activity", id: "instance" }],
        ];
        for (const [audience, target] of cases) {
          yield* bus.publish([
            {
              audience: ProjectScope.make({ project: ProjectId.make("hidden") }),
              target: { ...target, id: "secret" },
            },
            { audience: InstanceScope.make(), target: { kind: "worker", id: "secret-worker" } },
            { audience, target },
          ]);
        }
        const grants = [
          PermissionGrant.make({ permission: "read", scope: ProjectScope.make({ project }) }),
        ];

        const frames = yield* (yield* open(initial.revision, grants)).pipe(
          Stream.take(1),
          Stream.runCollect,
        );
        const replay = frames.join("");
        for (const [, target] of cases) {
          const encodedTarget = jsonKey(target);
          assert.include(replay, encodedTarget);
        }
        assert.notInclude(replay, "secret");
        assert.notInclude(replay, '"reset":true');

        const admin = yield* (yield* open(initial.revision)).pipe(
          Stream.take(1),
          Stream.runCollect,
        );
        assert.include(admin.join(""), "secret-worker");
      }).pipe(
        Effect.provide((yield* live).pipe(Layer.provideMerge(changeBusLayer))),
        Effect.scoped,
      );
    }),
);

it.effect("resets expired and future cursors and slow subscribers after a bounded replay gap", () =>
  Effect.gen(function* () {
    return yield* Effect.gen(function* () {
      const bus = yield* ChangeBus;
      const initial = yield* bus.open;
      for (let index = 0; index < 257; index++)
        yield* bus.publish([
          { audience: InstanceScope.make(), target: { kind: "worker", id: String(index) } },
        ]);
      for (const cursor of [initial.revision, Number.MAX_SAFE_INTEGER, "invalid"]) {
        const frames = yield* (yield* open(cursor)).pipe(Stream.take(1), Stream.runCollect);
        assert.include(frames.join(""), '"reset":true');
      }

      assert.strictEqual((yield* bus.open).history.length, 256);
    }).pipe(Effect.provide((yield* live).pipe(Layer.provideMerge(changeBusLayer))), Effect.scoped);
  }),
);

it.effect("revalidates credentials before a write can reveal an identifier", () =>
  Effect.gen(function* () {
    return yield* Effect.gen(function* () {
      let permitted = true;
      const verify = Effect.suspend(() =>
        permitted
          ? Effect.void
          : Effect.fail(AuthError.make({ status: 401, message: "credentials revoked" })),
      );
      const stream = yield* open().pipe(Effect.provideService(ChangeAccess, verify));
      const frames: string[] = [];
      const reader = yield* stream.pipe(
        Stream.runForEach((frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      permitted = false;

      yield* (yield* ChangeBus).publish([
        {
          audience: InstanceScope.make(),
          target: { kind: "worker", id: "hidden-after-revocation" },
        },
      ]);
      const exit = yield* Fiber.await(reader);
      assert.strictEqual(exit._tag, "Failure");
      assert.notInclude(frames.join(""), "hidden-after-revocation");
    }).pipe(Effect.provide((yield* live).pipe(Layer.provideMerge(changeBusLayer))), Effect.scoped);
  }),
);

it.effect("ends open streams before the routes close and the member store follows", () => {
  const logs: Array<{
    readonly level: string;
    readonly message: unknown;
    readonly fields: unknown;
  }> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    const [text, fields] = Array.isArray(message) ? message : [message];
    logs.push({ level: logLevel, message: text, fields });
  });
  return Effect.gen(function* () {
    let storeOpen = true;
    let checks = 0;
    const verify = Effect.suspend(() => {
      checks++;
      return storeOpen
        ? Effect.void
        : Effect.fail(AuthError.make({ status: 500, message: "The member store is unavailable." }));
    });
    const { revision } = yield* Effect.scoped((yield* ChangeBus).open);
    const routes = yield* Scope.make();
    const layer = yield* live;
    const changes = yield* Layer.buildWithScope(layer, routes);
    const stream = yield* open().pipe(
      Effect.provideService(ChangeAccess, verify),
      Effect.provideContext(changes),
    );
    const reader = yield* stream.pipe(Stream.runCollect, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    const opened = checks;

    yield* Scope.close(routes, Exit.void);
    storeOpen = false;
    yield* TestClock.adjust("30 seconds");

    const exit = yield* Fiber.await(reader);
    assert.strictEqual(exit._tag, "Success");
    assert.isAbove(opened, 0);
    assert.strictEqual(checks, opened);
    assert.deepStrictEqual(
      logs.filter(({ level }) => level === "Warn" || level === "Error"),
      [],
    );
    assert.deepStrictEqual(
      logs.filter(({ message }) => message === "Change stream ended because its routes closed"),
      [
        {
          level: "Info",
          message: "Change stream ended because its routes closed",
          fields: { resume: revision },
        },
      ],
    );
  }).pipe(Effect.provide(Layer.merge(changeBusLayer, Logger.layer([logger]))));
});

it.effect("waits for a running credential check before the routes close", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let checks = 0;
    const verify = Effect.suspend(() =>
      ++checks === 2
        ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void,
    );
    const routes = yield* Scope.make();
    const layer = yield* live;
    const changes = yield* Layer.buildWithScope(layer, routes);
    const stream = yield* open().pipe(
      Effect.provideService(ChangeAccess, verify),
      Effect.provideContext(changes),
    );
    const reader = yield* stream.pipe(Stream.runCollect, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    yield* Deferred.await(started);

    const closed = yield* Scope.close(routes, Exit.void).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 minute");
    assert.isUndefined(closed.pollUnsafe());
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(closed);

    const exit = yield* Fiber.await(reader);
    assert.strictEqual(exit._tag, "Success");
    assert.strictEqual(checks, 2);
  }).pipe(Effect.provide(changeBusLayer)),
);

it.effect("closes the routes without waiting for a stream whose reader stopped reading", () =>
  Effect.gen(function* () {
    let checks = 0;
    const verify = Effect.sync(() => {
      checks++;
    });
    const routes = yield* Scope.make();
    const layer = yield* live;
    const changes = yield* Layer.buildWithScope(layer, routes);
    const entered = yield* Deferred.make<void>();
    const stream = yield* open().pipe(
      Effect.provideService(ChangeAccess, verify),
      Effect.provideContext(changes),
    );
    let frames = 0;
    yield* stream.pipe(
      Stream.tap(() =>
        ++frames === 2
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      ),
      Stream.runDrain,
      Effect.forkChild,
    );
    yield* TestClock.adjust("15 seconds");
    yield* Deferred.await(entered);

    yield* Scope.close(routes, Exit.void);
    const closed = checks;
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(checks, closed);
  }).pipe(Effect.provide(changeBusLayer)),
);

it.effect("runs no credential check and sends no notice published after the routes close", () =>
  Effect.gen(function* () {
    let checks = 0;
    const verify = Effect.sync(() => {
      checks++;
    });
    const routes = yield* Scope.make();
    const layer = yield* live;
    const changes = yield* Layer.buildWithScope(layer, routes);
    const stream = yield* open().pipe(
      Effect.provideService(ChangeAccess, verify),
      Effect.provideContext(changes),
    );
    const ready = yield* Deferred.make<void>();
    const frames: string[] = [];
    const reader = yield* stream.pipe(
      Stream.runForEach((frame) =>
        Effect.sync(() => {
          frames.push(frame);
        }).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(ready);
    const opened = checks;

    yield* Scope.close(routes, Exit.void);
    yield* (yield* ChangeBus).publish([
      { audience: InstanceScope.make(), target: { kind: "worker", id: "after-close" } },
    ]);

    const exit = yield* Fiber.await(reader);
    assert.strictEqual(exit._tag, "Success");
    assert.strictEqual(checks, opened);
    assert.notInclude(frames.join(""), "after-close");
  }).pipe(Effect.provide(changeBusLayer)),
);

it.effect(
  "runs no credential check and sends no notice on a stream opened after the routes close",
  () =>
    Effect.gen(function* () {
      let checks = 0;
      const verify = Effect.sync(() => {
        checks++;
      });
      const routes = yield* Scope.make();
      const layer = yield* live;
      const changes = yield* Layer.buildWithScope(layer, routes);
      const bus = yield* ChangeBus;
      const pending = (yield* Effect.scoped(bus.open)).revision;
      yield* bus.publish([
        { audience: InstanceScope.make(), target: { kind: "worker", id: "replayed" } },
      ]);
      const current = (yield* Effect.scoped(bus.open)).revision;
      yield* Scope.close(routes, Exit.void);

      const cases: ReadonlyArray<readonly [number | undefined, ReadonlyArray<string>]> = [
        [undefined, []],
        [pending, []],
        [current, [": heartbeat\n\n"]],
      ];
      for (const [cursor, expected] of cases) {
        const stream = yield* open(cursor).pipe(
          Effect.provideService(ChangeAccess, verify),
          Effect.provideContext(changes),
        );
        const frames = yield* Stream.runCollect(stream);
        assert.deepStrictEqual(frames, expected);
      }
      assert.strictEqual(checks, 0);
    }).pipe(Effect.provide(changeBusLayer)),
);

it.effect("resets a live subscriber whose queue drops committed writes", () =>
  Effect.gen(function* () {
    return yield* Effect.gen(function* () {
      const bus = yield* ChangeBus;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;

      const reader = yield* (yield* open()).pipe(
        Stream.tap(() => {
          if (!first) return Effect.void;
          first = false;
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
        }),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      for (let index = 0; index < 257; index++)
        yield* bus.publish([
          { audience: InstanceScope.make(), target: { kind: "worker", id: String(index) } },
        ]);
      yield* Deferred.succeed(release, undefined);
      const frames = yield* Fiber.join(reader);
      assert.include(frames[1] ?? "", '"reset":true');
    }).pipe(Effect.provide((yield* live).pipe(Layer.provideMerge(changeBusLayer))), Effect.scoped);
  }),
);

it.effect(
  "filters live run transitions by loop ownership and keeps worker identities private",
  () =>
    Effect.gen(function* () {
      return yield* Effect.gen(function* () {
        const bus = yield* ChangeBus;
        const ready = yield* Deferred.make<void>();
        const grants = [
          PermissionGrant.make({ permission: "read", scope: ProjectScope.make({ project }) }),
        ];
        let first = true;

        const reader = yield* (yield* open(undefined, grants)).pipe(
          Stream.tap(() => {
            if (!first) return Effect.void;
            first = false;
            return Deferred.succeed(ready, undefined);
          }),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        yield* bus.publish([
          {
            audience: { _tag: "Repository", repository: RepositoryName.make("owner/hidden") },
            target: { kind: "item", id: "secret-live" },
          },
          { audience: InstanceScope.make(), target: { kind: "worker", id: "secret-worker" } },
        ]);
        yield* bus.publish([
          {
            audience: { _tag: "Loop", loop: LoopName.make("visible/developer") },
            target: { kind: "run", id: "preparing-run" },
          },
        ]);
        const frames = yield* Fiber.join(reader);
        const liveFrame = frames[1] ?? "";
        assert.notInclude(frames.join(""), "secret");
        assert.include(liveFrame, '{"kind":"run","id":"preparing-run"}');
        assert.include(liveFrame, '{"kind":"project","id":"visible"}');
        assert.notInclude(liveFrame, '"reset":true');
      }).pipe(
        Effect.provide((yield* live).pipe(Layer.provideMerge(changeBusLayer))),
        Effect.scoped,
      );
    }),
);
