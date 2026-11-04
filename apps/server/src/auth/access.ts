import {
  ConfigurationStore,
  ConfigurationChange,
  ConfigurationEntityKey,
  ConfigurationEntityId,
} from "@usine/config/configuration";
import {
  GitHubUserId,
  RoleBinding,
  type PermissionGrant,
  InstanceScope,
  permits,
} from "@usine/core/access";
import { requestActor, localActor } from "@usine/core/operator";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { make as makeMigrator, fromRecord } from "effect/sql/Migrator";
import { AuthStore } from "./store.ts";
import { AuthError, authFailure, type Member } from "./model.ts";

export class MemberAccess extends Context.Service<
  MemberAccess,
  {
    readonly permissions: (
      member: GitHubUserId,
    ) => Effect.Effect<ReadonlyArray<PermissionGrant>, AuthError>;
    readonly remove: (member: GitHubUserId) => Effect.Effect<void, AuthError>;
    readonly enroll: (member: Member) => Effect.Effect<void, AuthError>;
  }
>()("@usine/server/MemberAccess") {}

const grantAdministrators = Effect.fn("MemberAccess.grantAdministrators")(function* (
  members: ReadonlyArray<Member>,
) {
  const store = yield* ConfigurationStore;
  const snapshot = yield* store.read;
  if (Option.isNone(snapshot.instance))
    return yield* authFailure("Initialize configuration before enrolling members.", 503);
  const bindings = snapshot.instance.value.config.bindings;
  const changes = members
    .filter(
      (member) =>
        !bindings.some((binding) => binding.member === member.id && binding.role === "admin"),
    )
    .map((member) => {
      const name = `member-${member.id}-admin`;
      const binding = RoleBinding.make({
        name,
        member: member.id,
        role: "admin",
        scope: InstanceScope.make(),
      });
      return ConfigurationChange.make({
        key: ConfigurationEntityKey.make({
          kind: "binding",
          identifier: ConfigurationEntityId.make(name),
        }),
        before: Option.none(),
        after: Option.some(Schema.encodeSync(RoleBinding)(binding)),
      });
    });
  if (changes.length === 0) return;
  yield* store.commit({
    expected: snapshot.number,
    actor: Option.some(localActor),
    message: Option.some("Granted instance admin access to enrolled members"),
    changes,
  });
  yield* Effect.logInfo("Instance admin bindings recorded", {
    members: members.map(({ id }) => id),
  });
});

const unavailable = (cause: unknown) =>
  Effect.logError("Role binding operation failed", { cause }).pipe(
    Effect.andThen(authFailure("Role bindings are unavailable.", 500)),
  );

export const memberAccessLayer = Layer.effect(
  MemberAccess,
  Effect.gen(function* () {
    const configuration = yield* ConfigurationStore;
    const store = yield* AuthStore;
    const sql = yield* SqlClient.SqlClient;
    yield* makeMigrator({})({
      table: "usine_access_migrations",
      loader: fromRecord({
        "0001_role_bindings": Effect.flatMap(store.members, grantAdministrators).pipe(
          Effect.provideService(ConfigurationStore, configuration),
        ),
      }),
    }).pipe(Effect.catch(unavailable));
    return MemberAccess.of({
      permissions: Effect.fn("MemberAccess.permissions")(function* (member) {
        yield* Effect.annotateCurrentSpan({ memberId: member });
        const snapshot = yield* configuration.read.pipe(Effect.catch(unavailable));
        return Option.match(snapshot.instance, {
          onNone: () => [],
          onSome: ({ config }) =>
            config.bindings
              .filter((binding) => binding.member === member)
              .flatMap((binding) => binding.permissions),
        });
      }),
      remove: Effect.fn("MemberAccess.remove")((id) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({ memberId: id });
          const snapshot = yield* configuration.read;
          const bindings = Option.match(snapshot.instance, {
            onNone: () => [],
            onSome: ({ config }) => config.bindings,
          });
          const members = yield* store.members;
          const admins = members.filter((member) =>
            permits(
              bindings
                .filter((binding) => binding.member === member.id)
                .flatMap((binding) => binding.permissions),
              "admin",
              InstanceScope.make(),
            ),
          );
          if (admins.length === 1 && admins[0]?.id === id)
            return yield* authFailure(
              "Grant another member instance admin access before removing the last admin.",
              409,
            );
          const changes = bindings
            .filter((binding) => binding.member === id)
            .map((binding) =>
              ConfigurationChange.make({
                key: ConfigurationEntityKey.make({
                  kind: "binding",
                  identifier: ConfigurationEntityId.make(binding.name),
                }),
                before: Option.some(Schema.encodeSync(RoleBinding)(binding)),
                after: Option.none(),
              }),
            );
          yield* store.remove(id);
          if (changes.length > 0)
            yield* configuration.commit({
              expected: snapshot.number,
              actor: yield* requestActor(Option.some(localActor)),
              message: Option.some("Removed member role bindings"),
              changes,
            });
          yield* Effect.logInfo("Member and role bindings removed", { memberId: id });
        }).pipe(
          sql.withTransaction,
          Effect.provideService(SqlClient.BeginTransaction, "BEGIN IMMEDIATE"),
          Effect.catchIf(
            (error) => !Schema.is(AuthError)(error),
            (error) => unavailable(error),
          ),
        ),
      ),
      enroll: Effect.fn("MemberAccess.enroll")((member) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({ memberId: member.id });
          yield* store.add(member, true);
          yield* grantAdministrators([member]);
        }).pipe(
          Effect.provideService(ConfigurationStore, configuration),
          sql.withTransaction,
          Effect.provideService(SqlClient.BeginTransaction, "BEGIN IMMEDIATE"),
          Effect.catchIf(
            (error) => !Schema.is(AuthError)(error),
            (error) => unavailable(error),
          ),
        ),
      ),
    });
  }),
);
