import {
  type AllowedRequest,
  answeredAt,
  answeredByMember,
  isAllowed,
  PermissionRequest,
  reportIn,
  revokeGrant,
  StandingGrant,
  type StandingGrantId,
  useGrant,
} from "@usine/core/permission-request";
import { TurnId } from "@usine/core/conversation";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { Migrator, SqlClient, type Statement } from "effect/sql";
import { PermissionStore, PermissionStoreError, RequestConflict } from "./store.ts";

const json = <S extends Schema.Top>(schema: S) => Schema.fromJsonString(Schema.toCodecJson(schema));

const RequestJson = json(PermissionRequest);
const GrantJson = json(StandingGrant);

// Every value written was validated at construction, so an encoding failure is a defect.
const encode =
  <T>(codec: Schema.Codec<T, string>) =>
  (value: T) =>
    Schema.encodeEffect(codec)(value).pipe(Effect.orDie);

const decodeValues = <T>(codec: Schema.Codec<T, string>) => {
  const decode = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ value: codec })));
  return (rows: ReadonlyArray<unknown>) =>
    decode(rows).pipe(Effect.map((decoded) => decoded.map(({ value }) => value)));
};
const decodeRequests = decodeValues(RequestJson);
const decodeGrants = decodeValues(GrantJson);
const decodeTurns = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ turn_id: TurnId })));

/** The indexed columns of `request`; `value` holds the request itself. */
const requestColumns = (request: PermissionRequest) =>
  Effect.map(encode(RequestJson)(request), (value) => ({
    id: request.id,
    conversation_id: request.conversation,
    audience_project: request.audience._tag === "Project" ? request.audience.project : null,
    turn_id: request.turn,
    state: request.state._tag,
    requested_at: DateTime.toEpochMillis(request.requestedAt),
    answered_at: Option.getOrNull(Option.map(answeredAt(request), DateTime.toEpochMillis)),
    report_due: answeredByMember(request) && Option.isNone(request.reportedIn) ? 1 : 0,
    value,
  }));

/**
 * Provides the permission store on the application's `SqlClient`. Applies its migrations with
 * their own `usine_permission_migrations` ledger, and runs each write in one `BEGIN IMMEDIATE`
 * transaction. Rows hold Schema-encoded JSON values; the other columns index them.
 */
export const sqlitePermissionStoreLayer = Layer.effect(
  PermissionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrator.make({})({
      table: "usine_permission_migrations",
      loader: Migrator.fromRecord({
        "0001_permissions": Effect.gen(function* () {
          yield* sql`CREATE TABLE usine_permission_requests (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, audience_project TEXT, turn_id TEXT NOT NULL, state TEXT NOT NULL, requested_at INTEGER NOT NULL, answered_at INTEGER, report_due INTEGER NOT NULL, value TEXT NOT NULL)`;
          yield* sql`CREATE INDEX usine_permission_requests_conversation ON usine_permission_requests (conversation_id, requested_at)`;
          yield* sql`CREATE INDEX usine_permission_requests_turn ON usine_permission_requests (turn_id)`;
          yield* sql`CREATE INDEX usine_permission_requests_state ON usine_permission_requests (state)`;
          yield* sql`CREATE INDEX usine_permission_requests_report ON usine_permission_requests (report_due)`;
          yield* sql`CREATE INDEX usine_permission_requests_answered ON usine_permission_requests (audience_project, answered_at)`;
          yield* sql`CREATE TABLE usine_standing_grants (id TEXT PRIMARY KEY, revoked INTEGER NOT NULL, created_at INTEGER NOT NULL, value TEXT NOT NULL)`;
          yield* sql`CREATE INDEX usine_standing_grants_revoked ON usine_standing_grants (revoked, created_at)`;
        }),
      }),
    }).pipe(Effect.orDie);

    const failure = (operation: string) => (cause: unknown) =>
      Effect.fail(PermissionStoreError.make({ operation, cause }));
    const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        sql.withTransaction,
        Effect.provideService(SqlClient.BeginTransaction, "BEGIN IMMEDIATE"),
      );

    const insertRequest = (request: PermissionRequest) =>
      Effect.gen(function* () {
        const columns = yield* requestColumns(request);
        yield* sql`INSERT INTO usine_permission_requests ${sql.insert(columns)}`;
      });
    const updateRequest = (request: PermissionRequest, expected: string) =>
      Effect.gen(function* () {
        const { id: _id, ...columns } = yield* requestColumns(request);
        return yield* sql`UPDATE usine_permission_requests SET ${sql.update(columns)} WHERE id = ${request.id} AND state = ${expected} RETURNING id`;
      });
    const saveGrant = (grant: StandingGrant) =>
      Effect.gen(function* () {
        const value = yield* encode(GrantJson)(grant);
        yield* sql`INSERT INTO usine_standing_grants ${sql.insert({
          id: grant.id,
          revoked: Option.isSome(grant.revoked) ? 1 : 0,
          created_at: DateTime.toEpochMillis(grant.createdAt),
          value,
        })} ON CONFLICT (id) DO UPDATE SET revoked = excluded.revoked, value = excluded.value`;
      });
    const loadGrant = (id: StandingGrantId) =>
      sql`SELECT value FROM usine_standing_grants WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeGrants),
        Effect.map((grants) => Option.fromUndefinedOr(grants[0])),
      );
    const updateGrant = (id: StandingGrantId, update: (grant: StandingGrant) => StandingGrant) =>
      Effect.gen(function* () {
        const current = yield* loadGrant(id);
        if (Option.isNone(current)) return Option.none<StandingGrant>();
        const next = update(current.value);
        yield* saveGrant(next);
        return Option.some(next);
      });
    const requestsWhere = (filter: Statement.Fragment) =>
      sql`SELECT value FROM usine_permission_requests WHERE ${filter} ORDER BY requested_at, id`.pipe(
        Effect.flatMap(decodeRequests),
      );

    return PermissionStore.of({
      create: Effect.fn("PermissionStore.create")(function* (request, used) {
        yield* Effect.annotateCurrentSpan({ request: request.id });
        yield* Effect.gen(function* () {
          yield* insertRequest(request);
          if (Option.isSome(used))
            yield* updateGrant(used.value, (grant) => useGrant(grant, request.requestedAt));
        }).pipe(
          transaction,
          Effect.catchTag(["SqlError", "SchemaError"], failure("store a permission request")),
        );
      }),
      transition: Effect.fn("PermissionStore.transition")(function* (from, to, grant) {
        yield* Effect.annotateCurrentSpan({ request: from.id, from: from.state._tag });
        yield* Effect.gen(function* () {
          const updated = yield* updateRequest(to, from.state._tag);
          if (updated.length === 0)
            return yield* RequestConflict.make({ request: from.id, expected: from.state._tag });
          if (Option.isSome(grant)) yield* saveGrant(grant.value);
        }).pipe(transaction, Effect.catchTag("SqlError", failure("change a permission request")));
      }),
      get: Effect.fn("PermissionStore.get")(function* (id) {
        return yield* requestsWhere(sql`id = ${id}`).pipe(
          Effect.map((requests) => Option.fromUndefinedOr(requests[0])),
          Effect.catchTag(["SqlError", "SchemaError"], failure("read a permission request")),
        );
      }),
      ofConversation: Effect.fn("PermissionStore.ofConversation")(function* (conversation) {
        return yield* requestsWhere(sql`conversation_id = ${conversation}`).pipe(
          Effect.catchTag(["SqlError", "SchemaError"], failure("read a conversation's requests")),
        );
      }),
      ofTurn: Effect.fn("PermissionStore.ofTurn")(function* (turn) {
        return yield* requestsWhere(sql`turn_id = ${turn}`).pipe(
          Effect.catchTag(["SqlError", "SchemaError"], failure("read a turn's requests")),
        );
      }),
      running: requestsWhere(sql`state = 'Allowed'`).pipe(
        Effect.map((requests): ReadonlyArray<AllowedRequest> => requests.filter(isAllowed)),
        Effect.catchTag(["SqlError", "SchemaError"], failure("read running calls")),
        Effect.withSpan("PermissionStore.running"),
      ),
      unreported:
        sql`SELECT DISTINCT turn_id FROM usine_permission_requests WHERE report_due = 1 ORDER BY turn_id`.pipe(
          Effect.flatMap(decodeTurns),
          Effect.map((rows) => rows.map(({ turn_id }) => turn_id)),
          Effect.catchTag(["SqlError", "SchemaError"], failure("read unreported requests")),
          Effect.withSpan("PermissionStore.unreported"),
        ),
      report: Effect.fn("PermissionStore.report")(function* (turn, followUp) {
        yield* Effect.annotateCurrentSpan({ turn, followUp });
        yield* Effect.gen(function* () {
          const requests = yield* requestsWhere(sql`turn_id = ${turn} AND report_due = 1`);
          for (const request of requests)
            yield* updateRequest(reportIn(request, followUp), request.state._tag);
        }).pipe(
          transaction,
          Effect.catchTag(["SqlError", "SchemaError"], failure("mark requests reported")),
        );
      }),
      actions: Effect.fn("PermissionStore.actions")(function* (limit, audience) {
        if (audience._tag === "Projects" && audience.projects.length === 0) return [];
        const readable =
          audience._tag === "Everyone"
            ? sql`1 = 1`
            : sql`audience_project IN ${sql.in(audience.projects)}`;
        return yield* sql`SELECT value FROM usine_permission_requests WHERE state NOT IN ('Waiting', 'Denied') AND ${readable} ORDER BY answered_at DESC, id DESC LIMIT ${limit}`.pipe(
          Effect.flatMap(decodeRequests),
          Effect.catchTag(["SqlError", "SchemaError"], failure("read allowed calls")),
        );
      }),
      grants:
        sql`SELECT value FROM usine_standing_grants WHERE revoked = 0 ORDER BY created_at, id`.pipe(
          Effect.flatMap(decodeGrants),
          Effect.catchTag(["SqlError", "SchemaError"], failure("read standing grants")),
          Effect.withSpan("PermissionStore.grants"),
        ),
      grant: Effect.fn("PermissionStore.grant")(function* (id) {
        return yield* loadGrant(id).pipe(
          Effect.catchTag(["SqlError", "SchemaError"], failure("read a standing grant")),
        );
      }),
      revoke: Effect.fn("PermissionStore.revoke")(function* (id, revocation) {
        yield* Effect.annotateCurrentSpan({ grant: id });
        return yield* updateGrant(id, (grant) => revokeGrant(grant, revocation)).pipe(
          transaction,
          Effect.catchTag(["SqlError", "SchemaError"], failure("revoke a standing grant")),
        );
      }),
    });
  }),
);
