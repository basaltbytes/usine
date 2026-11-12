import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { NodeServices } from "@effect/platform-node";
import {
  ConfigurationStore,
  ConfigurationChange,
  ConfigurationEntityKey,
  ConfigurationEntityId,
} from "@usine/config/configuration";
import { InstanceDirectory } from "@usine/core/instance";
import { localActor } from "@usine/core/operator";
import { RoleBinding } from "@usine/core/access";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { MemberAccess, memberAccessLayer } from "../../src/auth/access.ts";
import { AuthStore } from "../../src/auth/store.ts";
import { sqliteAuthLayer } from "../../src/auth/sqlite.ts";
import { configurationLayer, initializeConfiguration } from "../../src/configuration/runtime.ts";
import { alice, bob } from "./fixture.ts";

/** Opens an initialized configuration and auth store in a temporary SQLite instance. */
const accessFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const currentDirectory = yield* fs.makeTempDirectoryScoped({
    directory: sqliteTempDirectory(),
    prefix: "usine-access-",
  });
  const directory = InstanceDirectory.make(currentDirectory);
  const services = yield* Layer.build(localSqliteLayer(directory));
  const database = Layer.succeedContext(services);
  const context = yield* Layer.build(
    Layer.merge(configurationLayer, sqliteAuthLayer).pipe(Layer.provide(database)),
  );
  yield* initializeConfiguration(directory).pipe(Effect.provideContext(context));
  const build = () =>
    Layer.build(
      memberAccessLayer.pipe(Layer.provide(Layer.succeedContext(context)), Layer.provide(database)),
    );
  return {
    store: Context.get(context, AuthStore),
    config: Context.get(context, ConfigurationStore),
    build,
  };
});

for (const existing of [true, false])
  it.live(`records admin bindings atomically (${existing ? "upgrade" : "first enrollment"})`, () =>
    Effect.gen(function* () {
      const { store, config, build } = yield* accessFixture;
      if (existing) {
        yield* store.add(alice, true);
        yield* store.add(bob, false);
      }
      const currentServices = yield* build();
      const access = Context.get(currentServices, MemberAccess);
      if (!existing) yield* access.enroll(alice);

      assert.equal((yield* access.permissions(alice.id))[0]?.permission, "admin");
      const snapshot = yield* config.read;
      assert.isTrue(Option.isSome(snapshot.instance));
      const revisions = yield* config.list(Option.none());
      assert.equal(revisions.at(-1)?.actor.pipe(Option.getOrNull), localActor);
      yield* build();

      assert.equal((yield* config.read).number, snapshot.number);

      assert.equal(
        (yield* access.remove(alice.id).pipe(Effect.result))._tag,
        existing ? "Success" : "Failure",
      );
      if (existing) {
        const currentPermissions = yield* access.permissions(alice.id);
        assert.deepEqual(currentPermissions, []);
        yield* store.add(alice, false);
        const nextPermissions = yield* access.permissions(alice.id);
        assert.deepEqual(nextPermissions, []);

        assert.equal((yield* access.permissions(bob.id))[0]?.permission, "admin");
      } else {
        assert.equal((yield* access.enroll(bob).pipe(Effect.flip)).status, 409);
        const updatedPermissions = yield* access.permissions(bob.id);
        assert.deepEqual(updatedPermissions, []);
      }
      // A role removed after migration is not restored on a later startup.
      const current = yield* config.read;
      const bindings = Option.match(current.instance, {
        onNone: () => [],
        onSome: ({ config }) => config.bindings,
      });
      yield* config.commit({
        expected: current.number,
        actor: Option.some(localActor),
        message: Option.none(),
        changes: yield* Effect.forEach(bindings, (binding) =>
          Schema.encodeEffect(RoleBinding)(binding).pipe(
            Effect.map((before) =>
              ConfigurationChange.make({
                key: ConfigurationEntityKey.make({
                  kind: "binding",
                  identifier: ConfigurationEntityId.make(binding.name),
                }),
                before: Option.some(before),
                after: Option.none(),
              }),
            ),
          ),
        ),
      });
      yield* build();
      const latestPermissions = yield* access.permissions(existing ? bob.id : alice.id);
      assert.deepEqual(latestPermissions, []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

it.live("refuses to remove the only instance admin while another member remains", () =>
  Effect.gen(function* () {
    const { store, build } = yield* accessFixture;
    const services = yield* build();
    const access = Context.get(services, MemberAccess);
    yield* access.enroll(alice);
    yield* store.add(bob, false);
    const bobPermissions = yield* access.permissions(bob.id);
    assert.deepEqual(bobPermissions, []);

    const refused = yield* access.remove(alice.id).pipe(Effect.flip);
    assert.equal(refused.status, 409);
    assert.include(refused.message, "before removing the last admin");
    const alicePermissions = yield* access.permissions(alice.id);
    assert.equal(alicePermissions[0]?.permission, "admin");
    const members = yield* store.members;
    assert.deepEqual(
      members.map(({ id }) => id),
      [alice.id, bob.id],
    );

    yield* access.remove(bob.id);
    const remaining = yield* store.members;
    assert.deepEqual(
      remaining.map(({ id }) => id),
      [alice.id],
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
