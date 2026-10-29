import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import { Effect, FileSystem, Layer, Option } from "effect";
import { assert, describe, it } from "vitest";
import { memoryAuthLayer } from "../../src/auth/memory.ts";
import { sqliteAuthLayer } from "../../src/auth/sqlite.ts";
import { InstanceToken, TokenId, TokenName } from "../../src/auth/model.ts";
import { secretHash } from "../../src/auth/crypto.ts";
import { AuthStore } from "../../src/auth/store.ts";
import { alice, bob } from "./fixture.ts";

const sqlLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fs.makeTempDirectoryScoped({ prefix: "usine-members-" }),
    );
    return sqliteAuthLayer.pipe(Layer.provide(localSqliteLayer(directory)));
  }),
).pipe(Layer.provide(NodeServices.layer));

for (const [name, layer] of [
  ["memory", memoryAuthLayer],
  ["sqlite", sqlLayer],
] as const)
  describe(`${name} member store contract`, () => {
    it("atomically enrolls the first member and preserves the last admin", async () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AuthStore;
          const results = yield* Effect.all(
            [store.add(alice, true).pipe(Effect.result), store.add(bob, true).pipe(Effect.result)],
            { concurrency: "unbounded" },
          );
          assert.equal(results.filter((result) => result._tag === "Success").length, 1);
          const members = yield* store.members;
          assert.lengthOf(members, 1);
          const first = members[0];
          assert.isDefined(first);
          if (first === undefined) return;
          assert.equal((yield* store.remove(first.id).pipe(Effect.flip)).status, 409);
          assert.lengthOf(yield* store.members, 1);
        }).pipe(Effect.provide(layer), Effect.scoped),
      ));
    it("updates last use and revokes every credential when a member is removed", async () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AuthStore;
          yield* store.add(alice, true);
          yield* store.add(bob, false);
          const token = new InstanceToken({
            id: TokenId.make("alice-device"),
            memberId: alice.id,
            name: TokenName.make("Phone"),
            hash: secretHash("secret"),
            kind: "device",
            createdAt: 1,
            lastUsedAt: 1,
            expiresAt: 100,
          });
          yield* store.issue(token);
          assert.isTrue(Option.isNone(yield* store.authenticate(secretHash("wrong"), 5)));
          const found = yield* store.authenticate(token.hash, 5);
          assert.isTrue(Option.isSome(found));
          assert.equal((yield* store.tokens(alice.id))[0]?.lastUsedAt, 5);
          assert.isTrue(Option.isNone(yield* store.authenticate(token.hash, 100)));
          yield* store.revoke(bob.id, token.id);
          assert.isTrue(Option.isSome(yield* store.authenticate(token.hash, 6)));
          yield* store.remove(alice.id);
          assert.isTrue(Option.isNone(yield* store.authenticate(token.hash, 7)));
          assert.deepEqual(yield* store.tokens(alice.id), []);
        }).pipe(Effect.provide(layer), Effect.scoped),
      ));
    it("rejects duplicate logins regardless of case and revokes a member's own token", async () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* AuthStore;
          yield* store.add(alice, true);
          assert.equal((yield* store.add(alice, false).pipe(Effect.flip)).status, 409);
          const token = new InstanceToken({
            id: TokenId.make("session"),
            memberId: alice.id,
            name: TokenName.make("Browser"),
            hash: secretHash("session"),
            kind: "session",
            createdAt: 1,
            lastUsedAt: 1,
            expiresAt: 100,
          });
          yield* store.issue(token);
          yield* store.revoke(alice.id, token.id);
          assert.isTrue(Option.isNone(yield* store.authenticate(token.hash, 2)));
        }).pipe(Effect.provide(layer), Effect.scoped),
      ));
  });
