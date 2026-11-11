import { PermissionGrant, ProjectScope } from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { OperatorLogin } from "@usine/core/operator";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import { TestClock } from "effect/testing";
import { DatabaseSync } from "node:sqlite";
import { Effect, FileSystem, Layer, Option } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { memoryAuthLayer } from "../../src/auth/memory.ts";
import { sqliteAuthLayer } from "../../src/auth/sqlite.ts";
import {
  GitHubUserId,
  GitHubIdentity,
  Member,
  InstanceToken,
  OperationCeilingChange,
  OperationId,
  TokenId,
  TokenName,
} from "../../src/auth/model.ts";
import { secretHash } from "../../src/auth/crypto.ts";
import { AuthStore } from "../../src/auth/store.ts";
import { alice, bob } from "./fixture.ts";

const sqlLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const currentDirectory = yield* fs.makeTempDirectoryScoped({
      directory: sqliteTempDirectory(),
      prefix: "usine-members-",
    });
    const directory = InstanceDirectory.make(currentDirectory);
    return sqliteAuthLayer.pipe(Layer.provide(localSqliteLayer(directory)));
  }),
).pipe(Layer.provide(NodeServices.layer));

for (const [name, layer] of [
  ["memory", memoryAuthLayer],
  ["sqlite", sqlLayer],
] as const)
  describe(`${name} member store contract`, () => {
    it.live("atomically enrolls the first member and preserves the last admin", () =>
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
        const currentMembers = yield* store.members;
        assert.lengthOf(currentMembers, 1);
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))), Effect.scoped),
    );
    it.live("changes only owned token scopes and preserves them when recording use", () =>
      Effect.gen(function* () {
        const store = yield* AuthStore;
        yield* store.add(alice, true);
        yield* store.add(bob, false);
        const token = InstanceToken.make({
          id: TokenId.make("scoped"),
          memberId: alice.id,
          name: TokenName.make("Scoped"),
          hash: secretHash("scoped-secret"),
          kind: "device",
          createdAt: 0,
          lastUsedAt: 0,
          expiresAt: 1000000,
        });
        yield* store.issue(token);
        const scopes = [
          PermissionGrant.make({
            permission: "read",
            scope: ProjectScope.make({ project: ProjectId.make("alpha") }),
          }),
        ];
        assert.equal(
          (yield* store
            .setScopes(bob.id, token.id, scopes, OperationCeilingChange.Keep())
            .pipe(Effect.flip)).status,
          403,
        );
        const operations = [OperationId.make("operator.approve")];
        yield* store.setScopes(
          alice.id,
          token.id,
          scopes,
          OperationCeilingChange.Replace({ operations }),
        );
        const access = yield* store.authenticate(token.hash, 61000);
        assert.deepEqual(Option.getOrNull(access)?.token.scopes, scopes);
        assert.deepEqual((yield* store.tokens(alice.id))[0]?.scopes, scopes);
        assert.deepEqual(Option.getOrNull(access)?.token.operations, Option.some(operations));
        yield* store.setScopes(alice.id, token.id, [], OperationCeilingChange.Keep());
        const kept = (yield* store.tokens(alice.id))[0];
        assert.deepEqual(kept?.scopes, []);
        assert.deepEqual(kept?.operations, Option.some(operations));
        yield* store.setScopes(alice.id, token.id, scopes, OperationCeilingChange.Remove());
        assert.isTrue(
          Option.isNone((yield* store.tokens(alice.id))[0]?.operations ?? Option.some([])),
        );
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))), Effect.scoped),
    );
    it.live("revokes every credential when a member is removed", () =>
      Effect.gen(function* () {
        const store = yield* AuthStore;
        yield* store.add(alice, true);
        yield* store.add(bob, false);
        const token = InstanceToken.make({
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
        const authenticatedToken = yield* store.authenticate(secretHash("wrong"), 5);
        assert.isTrue(Option.isNone(authenticatedToken));
        const found = yield* store.authenticate(token.hash, 5);
        assert.isTrue(Option.isSome(found));
        assert.equal((yield* store.tokens(alice.id))[0]?.lastUsedAt, 1);
        const currentAuthenticatedToken = yield* store.authenticate(token.hash, 100);
        assert.isTrue(Option.isNone(currentAuthenticatedToken));
        yield* store.revoke(bob.id, token.id);
        const nextAuthenticatedToken = yield* store.authenticate(token.hash, 6);
        assert.isTrue(Option.isSome(nextAuthenticatedToken));
        const renamed = yield* store.rename(
          GitHubIdentity.make({ id: alice.id, login: OperatorLogin.make("alice-renamed") }),
        );
        assert.deepEqual(
          renamed,
          Member.make({ ...alice, login: OperatorLogin.make("alice-renamed") }),
        );
        const updatedAuthenticatedToken = yield* store.authenticate(token.hash, 6);
        assert.equal(Option.getOrNull(updatedAuthenticatedToken)?.member.login, renamed.login);
        assert.equal(
          (yield* store
            .rename(GitHubIdentity.make({ id: alice.id, login: bob.login }))
            .pipe(Effect.flip)).status,
          409,
        );
        yield* store.add(Member.make({ ...alice, id: GitHubUserId.make(3) }), false);
        yield* store.remove(alice.id);
        assert.equal(
          (yield* store
            .rename(GitHubIdentity.make({ id: alice.id, login: renamed.login }))
            .pipe(Effect.flip)).status,
          403,
        );
        const latestAuthenticatedToken = yield* store.authenticate(token.hash, 7);
        assert.isTrue(Option.isNone(latestAuthenticatedToken));
        const currentTokens = yield* store.tokens(alice.id);
        assert.deepEqual(currentTokens, []);
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))), Effect.scoped),
    );
    it.live("rejects duplicate logins regardless of case and revokes a member's own token", () =>
      Effect.gen(function* () {
        const store = yield* AuthStore;
        yield* store.add(alice, true);
        assert.equal((yield* store.add(alice, false).pipe(Effect.flip)).status, 409);
        const token = InstanceToken.make({
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
        const authenticatedToken = yield* store.authenticate(token.hash, 2);
        assert.isTrue(Option.isNone(authenticatedToken));
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))), Effect.scoped),
    );
  });

for (const [name, layer] of [
  ["memory", memoryAuthLayer],
  ["sqlite", sqlLayer],
] as const)
  it.live(`${name} records use once a minute and deletes expired credentials when listing`, () =>
    Effect.gen(function* () {
      const store = yield* AuthStore;
      yield* store.add(alice, true);
      yield* store.add(bob, false);
      const token = InstanceToken.make({
        id: TokenId.make("active"),
        memberId: alice.id,
        name: TokenName.make("Browser"),
        hash: secretHash("active"),
        kind: "session",
        createdAt: 0,
        lastUsedAt: 0,
        expiresAt: 120000,
      });
      yield* store.issue(token);
      yield* store.issue(
        InstanceToken.make({
          ...token,
          id: TokenId.make("expired"),
          hash: secretHash("expired"),
          expiresAt: 60000,
        }),
      );
      yield* store.issue(
        InstanceToken.make({
          ...token,
          id: TokenId.make("other-member"),
          memberId: bob.id,
          hash: secretHash("other-member"),
          expiresAt: 60000,
        }),
      );
      for (const now of [1, 59_999]) {
        const authenticatedToken = yield* store.authenticate(token.hash, now);
        assert.equal(Option.getOrNull(authenticatedToken)?.token.lastUsedAt, 0);
      }
      yield* Effect.all(
        Array.from({ length: 5 }, () => store.authenticate(token.hash, 60_000)),
        { concurrency: "unbounded" },
      );
      const currentAuthenticatedToken = yield* store.authenticate(token.hash, 60_001);
      assert.equal(Option.getOrNull(currentAuthenticatedToken)?.token.lastUsedAt, 60_000);
      yield* TestClock.adjust("60 seconds");
      assert.deepEqual(
        (yield* store.tokens(alice.id)).map(({ id, lastUsedAt }) => ({ id, lastUsedAt })),
        [{ id: token.id, lastUsedAt: 60_000 }],
      );
      // Moving time back distinguishes deletion from filtering an expired row.
      const nextAuthenticatedToken = yield* store.authenticate(secretHash("expired"), 1);
      assert.isTrue(Option.isNone(nextAuthenticatedToken));
      const updatedAuthenticatedToken = yield* store.authenticate(secretHash("other-member"), 1);
      assert.isTrue(Option.isNone(updatedAuthenticatedToken));
      const latestAuthenticatedToken = yield* store.authenticate(token.hash, 120_000);
      assert.isTrue(Option.isNone(latestAuthenticatedToken));
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestClock.layer()))), Effect.scoped),
  );

it.live(
  "authenticates recently used SQLite tokens while another connection has the write lock",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const currentDirectory = yield* fs.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-auth-lock-",
      });
      const directory = InstanceDirectory.make(currentDirectory);
      yield* Effect.gen(function* () {
        const store = yield* AuthStore;
        yield* store.add(alice, true);
        const token = InstanceToken.make({
          id: TokenId.make("read-only"),
          memberId: alice.id,
          name: TokenName.make("Browser"),
          hash: secretHash("read-only"),
          kind: "session",
          createdAt: 0,
          lastUsedAt: 0,
          expiresAt: 120000,
        });
        yield* store.issue(token);
        const writer = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(`${directory}/.usine/runtime.sqlite`)),
          (database) => Effect.sync(() => database.close()),
        );
        writer.exec("BEGIN IMMEDIATE");
        const authenticatedToken = yield* store.authenticate(token.hash, 1);
        assert.isTrue(Option.isSome(authenticatedToken));
        writer.exec("ROLLBACK");
        writer.exec(
          "CREATE TABLE auth_updates (token_id TEXT); CREATE TRIGGER count_auth_updates AFTER UPDATE ON usine_instance_tokens BEGIN INSERT INTO auth_updates VALUES (new.id); END",
        );
        yield* Effect.all(
          Array.from({ length: 10 }, () => store.authenticate(token.hash, 60_000)),
          { concurrency: "unbounded" },
        );
        assert.equal(writer.prepare("SELECT count(*) AS count FROM auth_updates").get()?.count, 1);
      }).pipe(Effect.provide(sqliteAuthLayer.pipe(Layer.provide(localSqliteLayer(directory)))));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
