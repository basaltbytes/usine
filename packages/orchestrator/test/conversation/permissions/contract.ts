import { assert, describe, it } from "@effect/vitest";
import { type AccessScope, GitHubUserId, InstanceScope, ProjectScope } from "@usine/core/access";
import { ConversationId, PostedWithSession, TurnId, TurnMember } from "@usine/core/conversation";
import { OperatorLogin } from "@usine/core/operator";
import {
  allow,
  AllowedAlways,
  AllowedOnce,
  CallTarget,
  covered,
  CoveredByGrant,
  deny,
  GrantRevocation,
  OperationCall,
  OperationName,
  PermissionRequestId,
  requested,
  settle,
  StandingGrant,
  StandingGrantId,
} from "@usine/core/permission-request";
import { ProjectId } from "@usine/core/project";
import { DateTime, Effect, type Layer, Option, type Scope } from "effect";
import {
  type ActionAudience,
  PermissionStore,
} from "../../../src/conversation/permissions/store.ts";

export interface StoreFixture {
  /** Opens the same store in a fresh scope, preserving committed records. */
  readonly open: Layer.Layer<PermissionStore>;
}

export interface StoreAdapter {
  readonly name: string;
  /** Allocates isolated storage and removes it after the test. */
  readonly fixture: Effect.Effect<StoreFixture, never, Scope.Scope>;
}

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 9, minute));
const ada = TurnMember.make({ id: GitHubUserId.make(7), login: OperatorLogin.make("ada") });
const factory = ProjectScope.make({ project: ProjectId.make("factory") });
const other = ProjectScope.make({ project: ProjectId.make("other") });
const conversation = ConversationId.make("c1");

const call = OperationCall.make({
  operation: OperationName.make("retry"),
  summary: "Retry a failed run",
  arguments: { runId: "run-1" },
  target: CallTarget.make("run run-1"),
  scope: factory,
  permission: "operate",
});

const waiting = (id: string, turn: string, minute: number, audience: AccessScope = factory) =>
  requested({
    id: PermissionRequestId.make(id),
    conversation,
    audience,
    turn: TurnId.make(turn),
    toolCall: Option.some(`tool-${id}`),
    call,
    requestedAt: at(minute),
  });

const grantOf = (id: string, minute: number) =>
  StandingGrant.make({
    id: StandingGrantId.make(id),
    operation: call.operation,
    summary: call.summary,
    permission: "operate",
    project: ProjectId.make("factory"),
    member: ada,
    credential: PostedWithSession.make({}),
    request: PermissionRequestId.make("r1"),
    createdAt: at(minute),
    lastUsedAt: Option.none(),
    revoked: Option.none(),
  });

/** The behavior that every permission store adapter must have. */
export const permissionStoreContract = (adapter: StoreAdapter) =>
  describe(`PermissionStore: ${adapter.name}`, () => {
    const withStore = <A, E>(
      use: (store: PermissionStore["Service"], fixture: StoreFixture) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const fixture = yield* adapter.fixture;
        return yield* Effect.service(PermissionStore).pipe(
          Effect.flatMap((store) => use(store, fixture)),
          Effect.provide(fixture.open),
        );
      }).pipe(Effect.scoped);

    it.effect("reads requests by ID, conversation, and turn, oldest first, after a reopen", () =>
      withStore((store, fixture) =>
        Effect.gen(function* () {
          const later = waiting("r2", "t1", 2);
          const earlier = waiting("r1", "t1", 1);
          const other = waiting("r3", "t2", 3);
          for (const request of [later, earlier, other])
            yield* store.create(request, Option.none());
          yield* Effect.gen(function* () {
            const reopened = yield* PermissionStore;
            const read = yield* reopened.get(earlier.id);
            assert.deepStrictEqual(read, Option.some(earlier));
            assert.deepStrictEqual(
              (yield* reopened.ofConversation(conversation)).map(({ id }) => id),
              ["r1", "r2", "r3"],
            );
            assert.deepStrictEqual(
              (yield* reopened.ofTurn(TurnId.make("t1"))).map(({ id }) => id),
              ["r1", "r2"],
            );
          }).pipe(Effect.provide(fixture.open));
        }),
      ),
    );

    it.effect("applies a transition only from the stored state, with its grant in one write", () =>
      withStore((store) =>
        Effect.gen(function* () {
          const request = waiting("r1", "t1", 1);
          yield* store.create(request, Option.none());
          const grant = grantOf("g1", 2);
          const allowed = allow(
            request,
            AllowedAlways.make({ by: ada, at: at(2), grant: grant.id }),
          );
          yield* store.transition(request, allowed, Option.some(grant));
          const conflict = yield* store
            .transition(request, deny(request, ada, at(3)), Option.none())
            .pipe(Effect.flip);
          assert.strictEqual(conflict._tag, "RequestConflict");
          const stored = yield* store.get(request.id);
          assert.deepStrictEqual(stored, Option.some(allowed));
          const granted = yield* store.grant(grant.id);
          assert.deepStrictEqual(granted, Option.some(grant));
          assert.deepStrictEqual(
            (yield* store.running).map(({ id }) => id),
            ["r1"],
          );
          const ran = settle(allowed, at(4), { _tag: "Succeeded", result: "{}" });
          yield* store.transition(allowed, ran, Option.none());
          const running = yield* store.running;
          assert.isEmpty(running);
        }),
      ),
    );

    it.effect("lists the turns to report and marks only member-answered requests reported", () =>
      withStore((store) =>
        Effect.gen(function* () {
          const answered = waiting("r1", "t1", 1);
          const byGrant = covered(
            { ...waiting("r2", "t1", 2) },
            CoveredByGrant.make({ by: ada, at: at(2), grant: StandingGrantId.make("g1") }),
          );
          const unanswered = waiting("r3", "t2", 3);
          for (const request of [answered, byGrant, unanswered])
            yield* store.create(request, Option.none());
          const none = yield* store.unreported;
          assert.isEmpty(none);
          const denied = deny(answered, ada, at(4));
          yield* store.transition(answered, denied, Option.none());
          const due = yield* store.unreported;
          assert.deepStrictEqual(due, [TurnId.make("t1")]);
          yield* store.report(TurnId.make("t1"), TurnId.make("t1:outcomes"));
          const after = yield* store.unreported;
          assert.isEmpty(after);
          const reported = yield* store.ofTurn(TurnId.make("t1"));
          assert.deepStrictEqual(
            reported.map(({ id, reportedIn }) => [id, Option.getOrNull(reportedIn)]),
            [
              ["r1", "t1:outcomes"],
              ["r2", null],
            ],
          );
        }),
      ),
    );

    it.effect(
      "lists the allowed calls of readable conversations by latest answer, then limits",
      () =>
        withStore((store) =>
          Effect.gen(function* () {
            const first = waiting("r1", "t1", 1);
            const second = waiting("r2", "t1", 2);
            const refused = waiting("r3", "t1", 3);
            const open = waiting("r4", "t1", 4);
            const elsewhere = waiting("r5", "t2", 5, other);
            const onInstance = waiting("r6", "t3", 6, InstanceScope.make());
            for (const request of [first, second, refused, open, elsewhere, onInstance])
              yield* store.create(request, Option.none());
            for (const [request, minute] of [
              [first, 9],
              [second, 5],
              [elsewhere, 10],
              [onInstance, 11],
            ] as const)
              yield* store.transition(
                request,
                allow(request, AllowedOnce.make({ by: ada, at: at(minute) })),
                Option.none(),
              );
            yield* store.transition(refused, deny(refused, ada, at(6)), Option.none());
            const ids = (limit: number, audience: ActionAudience) =>
              Effect.map(store.actions(limit, audience), (requests) =>
                requests.map(({ id }) => id),
              );
            const everyone = yield* ids(10, { _tag: "Everyone" });
            assert.deepStrictEqual(everyone, ["r6", "r5", "r1", "r2"]);
            const factoryOnly = yield* ids(1, { _tag: "Projects", projects: [factory.project] });
            assert.deepStrictEqual(factoryOnly, ["r1"]);
            const none = yield* ids(10, { _tag: "Projects", projects: [] });
            assert.deepStrictEqual(none, []);
          }),
        ),
    );

    it.effect("records a grant's use with the request, and revokes a grant once", () =>
      withStore((store) =>
        Effect.gen(function* () {
          const grant = grantOf("g1", 1);
          const request = waiting("r1", "t1", 1);
          yield* store.create(request, Option.none());
          yield* store.transition(
            request,
            allow(request, AllowedAlways.make({ by: ada, at: at(1), grant: grant.id })),
            Option.some(grant),
          );
          const use = covered(
            { ...waiting("r2", "t2", 5) },
            CoveredByGrant.make({ by: ada, at: at(5), grant: grant.id }),
          );
          yield* store.create(use, Option.some(grant.id));
          const used = yield* store.grant(grant.id);
          assert.deepStrictEqual(
            Option.flatMap(used, ({ lastUsedAt }) => lastUsedAt),
            Option.some(at(5)),
          );
          const revocation = GrantRevocation.make({ by: ada.login, at: at(6) });
          const revoked = yield* store.revoke(grant.id, revocation);
          assert.deepStrictEqual(
            Option.flatMap(revoked, ({ revoked }) => revoked),
            Option.some(revocation),
          );
          const again = yield* store.revoke(
            grant.id,
            GrantRevocation.make({ by: ada.login, at: at(7) }),
          );
          assert.deepStrictEqual(
            Option.flatMap(again, ({ revoked }) => revoked),
            Option.some(revocation),
          );
          const active = yield* store.grants;
          assert.isEmpty(active);
          const missing = yield* store.revoke(StandingGrantId.make("missing"), revocation);
          assert.deepStrictEqual(missing, Option.none());
        }),
      ),
    );
  });
