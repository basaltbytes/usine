import { Migrator, SqlClient } from "effect/sql";
import { PermissionGrant } from "@usine/core/access";
import { Clock, Effect, Layer, Option, Schema } from "effect";

import {
  AuthError,
  authFailure,
  InstanceToken,
  Member,
  OperationCeilingChange,
  OperationId,
} from "./model.ts";
import { AuthStore } from "./store.ts";

const MemberJson = Schema.fromJsonString(Member);
const TokenJson = Schema.fromJsonString(InstanceToken);
const Row = Schema.Struct({ value: Schema.String });
const decodeRows = <A, I>(schema: Schema.Codec<A, I>, rows: ReadonlyArray<unknown>) =>
  Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(Row)(row).pipe(
      Effect.flatMap(({ value }) => Schema.decodeUnknownEffect(schema)(value)),
    ),
  );

export const sqliteAuthLayer = Layer.effect(
  AuthStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const failure = (operation: string) => (cause: unknown) =>
      Effect.logError("Member store operation failed", { operation, cause }).pipe(
        Effect.andThen(authFailure("The member store is unavailable.", 500)),
      );
    yield* Migrator.make({})({
      table: "usine_auth_migrations",
      loader: Migrator.fromRecord({
        "0001_members": Effect.gen(function* () {
          yield* sql`CREATE TABLE usine_members (id INTEGER PRIMARY KEY, login TEXT NOT NULL COLLATE NOCASE UNIQUE, value TEXT NOT NULL)`;
          yield* sql`CREATE TABLE usine_instance_tokens (id TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES usine_members(id) ON DELETE CASCADE, hash TEXT NOT NULL UNIQUE, expires_at REAL NOT NULL, value TEXT NOT NULL)`;
        }),
      }),
    }).pipe(Effect.catch(failure("migrate")));
    const members =
      sql`SELECT value FROM usine_members ORDER BY json_extract(value, '$.addedAt'), id`.pipe(
        Effect.flatMap((rows) => decodeRows(MemberJson, rows)),
        Effect.catch(failure("list members")),
      );
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        sql.withTransaction,
        Effect.provideService(SqlClient.BeginTransaction, "BEGIN IMMEDIATE"),
      );
    return AuthStore.of({
      members,
      add: Effect.fn("AuthStore.add")((member, onlyIfEmpty) =>
        Effect.gen(function* () {
          const current = yield* members;
          if (
            (onlyIfEmpty && current.length > 0) ||
            current.some(
              (entry) =>
                entry.id === member.id || entry.login.toLowerCase() === member.login.toLowerCase(),
            )
          )
            return yield* authFailure("This member already exists or setup has completed.", 409);
          const value = yield* Schema.encodeEffect(MemberJson)(member);
          yield* sql`INSERT INTO usine_members (id, login, value) VALUES (${member.id}, ${member.login}, ${value})`;
          yield* Effect.logInfo("Member added", { memberId: member.id, actor: member.addedBy });
        }).pipe(
          transaction,
          Effect.catchIf(
            (error) => !Schema.is(AuthError)(error),
            (error) => failure("add member")(error),
          ),
        ),
      ),
      rename: Effect.fn("AuthStore.rename")((identity) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({ memberId: identity.id });
          const current = yield* members;
          const member = current.find((entry) => entry.id === identity.id);
          if (member === undefined)
            return yield* authFailure("This GitHub login is not a member.", 403);
          if (member.login === identity.login) return member;
          if (
            current.some(
              (entry) =>
                entry.id !== identity.id &&
                entry.login.toLowerCase() === identity.login.toLowerCase(),
            )
          )
            return yield* authFailure("This GitHub login belongs to another member.", 409);
          const renamed = Member.make({ ...member, login: identity.login });
          const value = yield* Schema.encodeEffect(MemberJson)(renamed);
          yield* sql`UPDATE usine_members SET login = ${identity.login}, value = ${value} WHERE id = ${identity.id}`;
          yield* Effect.logInfo("Member login updated", {
            memberId: identity.id,
            login: identity.login,
          });
          return renamed;
        }).pipe(
          transaction,
          Effect.catchIf(
            (error) => !Schema.is(AuthError)(error),
            (error) => failure("rename member")(error),
          ),
        ),
      ),
      remove: Effect.fn("AuthStore.remove")((id) =>
        Effect.gen(function* () {
          const current = yield* members;
          if (current.length === 1 && current.some((entry) => entry.id === id))
            return yield* authFailure("Add another member before removing the last admin.", 409);
          yield* sql`DELETE FROM usine_instance_tokens WHERE member_id = ${id}`;
          yield* sql`DELETE FROM usine_members WHERE id = ${id}`;
          yield* Effect.logInfo("Member removed", { memberId: id });
        }).pipe(
          transaction,
          Effect.catchIf(
            (error) => !Schema.is(AuthError)(error),
            (error) => failure("remove member")(error),
          ),
        ),
      ),
      issue: Effect.fn("AuthStore.issue")((token) =>
        Effect.gen(function* () {
          if (!(yield* members).some((member) => member.id === token.memberId))
            return yield* authFailure("This GitHub login is not a member.", 403);
          const value = yield* Schema.encodeEffect(TokenJson)(token);
          yield* sql`INSERT INTO usine_instance_tokens (id, member_id, hash, expires_at, value) VALUES (${token.id}, ${token.memberId}, ${token.hash}, ${token.expiresAt}, ${value})`;
        }).pipe(
          transaction,
          Effect.catchIf(
            (error) => !Schema.is(AuthError)(error),
            (error) => failure("issue token")(error),
          ),
        ),
      ),
      authenticate: Effect.fn("AuthStore.authenticate")((hash, now) =>
        Effect.gen(function* () {
          const rows =
            yield* sql`SELECT value FROM usine_instance_tokens WHERE hash = ${hash} AND expires_at > ${now}`;
          const token = (yield* decodeRows(TokenJson, rows))[0];
          if (token === undefined) return Option.none();
          const memberRows =
            yield* sql`SELECT value FROM usine_members WHERE id = ${token.memberId}`;
          const member = (yield* decodeRows(MemberJson, memberRows))[0];
          if (member === undefined) return Option.none();
          yield* Effect.annotateCurrentSpan({ memberId: member.id, tokenId: token.id });
          const used = token.recordUse(now);
          if (used === token) {
            yield* Effect.logDebug("Instance token last use unchanged", { tokenId: token.id });
            return Option.some({ member, token });
          }
          const updated =
            yield* sql`UPDATE usine_instance_tokens SET value = json_set(value, '$.lastUsedAt', ${used.lastUsedAt}) WHERE id = ${token.id} AND json_extract(value, '$.lastUsedAt') = ${token.lastUsedAt} RETURNING value`;
          const current = (yield* decodeRows(TokenJson, updated))[0];
          yield* Effect.logDebug("Instance token last use recorded", {
            memberId: member.id,
            tokenId: token.id,
            updated: updated.length > 0,
          });
          return Option.some({ member, token: current ?? token });
        }).pipe(Effect.catch(failure("authenticate"))),
      ),
      tokens: Effect.fn("AuthStore.tokens")((id) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({ memberId: id });
          const now = yield* Clock.currentTimeMillis;
          const expired =
            yield* sql`DELETE FROM usine_instance_tokens WHERE expires_at <= ${now} RETURNING id`;
          if (expired.length > 0)
            yield* Effect.logInfo("Expired instance tokens deleted", { count: expired.length });
          return yield* sql`SELECT value FROM usine_instance_tokens WHERE member_id = ${id} AND expires_at > ${now}`.pipe(
            Effect.flatMap((rows) => decodeRows(TokenJson, rows)),
          );
        }).pipe(Effect.catch(failure("list tokens"))),
      ),
      setScopes: Effect.fn("AuthStore.setScopes")((member, id, scopes, change) =>
        Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Array(PermissionGrant)),
          )(scopes);
          const rows = yield* OperationCeilingChange.$match(change, {
            Keep: () =>
              sql`UPDATE usine_instance_tokens SET value = json_set(value, '$.scopes', json(${encoded})) WHERE id = ${id} AND member_id = ${member} RETURNING id`,
            Remove: () =>
              sql`UPDATE usine_instance_tokens SET value = json_remove(json_set(value, '$.scopes', json(${encoded})), '$.operations') WHERE id = ${id} AND member_id = ${member} RETURNING id`,
            Replace: ({ operations }) =>
              Schema.encodeEffect(Schema.fromJsonString(Schema.Array(OperationId)))(
                operations,
              ).pipe(
                Effect.flatMap(
                  (ceiling) =>
                    sql`UPDATE usine_instance_tokens SET value = json_set(value, '$.scopes', json(${encoded}), '$.operations', json(${ceiling})) WHERE id = ${id} AND member_id = ${member} RETURNING id`,
                ),
              ),
          });
          if (rows.length === 0) return yield* authFailure("Token not found.", 403);
          yield* Effect.logInfo("Token scopes changed", {
            memberId: member,
            tokenId: id,
            operationCeiling: change._tag,
          });
        }).pipe(
          Effect.catchIf(
            (error) => !Schema.is(AuthError)(error),
            (error) => failure("set token scopes")(error),
          ),
        ),
      ),
      revoke: Effect.fn("AuthStore.revoke")((member, id) =>
        sql`DELETE FROM usine_instance_tokens WHERE id = ${id} AND member_id = ${member}`.pipe(
          Effect.andThen(
            Effect.logInfo("Instance token revoked", { memberId: member, tokenId: id }),
          ),
          Effect.catch(failure("revoke token")),
        ),
      ),
    });
  }),
);
