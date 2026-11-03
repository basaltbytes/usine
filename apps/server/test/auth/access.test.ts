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
import { assert, it } from "vitest";
import { MemberAccess, memberAccessLayer } from "../../src/auth/access.ts";
import { AuthStore } from "../../src/auth/store.ts";
import { sqliteAuthLayer } from "../../src/auth/sqlite.ts";
import { configurationLayer, initializeConfiguration } from "../../src/configuration/runtime.ts";
import { alice, bob } from "./fixture.ts";

for (const existing of [true, false])
  it(`records admin bindings atomically (${existing ? "upgrade" : "first enrollment"})`, async () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = InstanceDirectory.make(
          yield* fs.makeTempDirectoryScoped({
            directory: sqliteTempDirectory(),
            prefix: "usine-access-",
          }),
        );
        const database = Layer.succeedContext(yield* Layer.build(localSqliteLayer(directory)));
        const context = yield* Layer.build(
          Layer.merge(configurationLayer, sqliteAuthLayer).pipe(Layer.provide(database)),
        );
        yield* initializeConfiguration(directory).pipe(Effect.provideContext(context));
        const store = Context.get(context, AuthStore);
        const config = Context.get(context, ConfigurationStore);
        if (existing) {
          yield* store.add(alice, true);
          yield* store.add(bob, false);
        }
        const build = () =>
          Layer.build(
            memberAccessLayer.pipe(
              Layer.provide(Layer.succeedContext(context)),
              Layer.provide(database),
            ),
          );
        const access = Context.get(yield* build(), MemberAccess);
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
          assert.deepEqual(yield* access.permissions(alice.id), []);
          yield* store.add(alice, false);
          assert.deepEqual(yield* access.permissions(alice.id), []);
          assert.equal((yield* access.permissions(bob.id))[0]?.permission, "admin");
        } else {
          assert.equal((yield* access.enroll(bob).pipe(Effect.flip)).status, 409);
          assert.deepEqual(yield* access.permissions(bob.id), []);
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
          changes: bindings.map((binding) =>
            ConfigurationChange.make({
              key: ConfigurationEntityKey.make({
                kind: "binding",
                identifier: ConfigurationEntityId.make(binding.name),
              }),
              before: Option.some(Schema.encodeSync(RoleBinding)(binding)),
              after: Option.none(),
            }),
          ),
        });
        yield* build();
        assert.deepEqual(yield* access.permissions(existing ? bob.id : alice.id), []);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    ));
