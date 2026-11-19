import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  type AccessScope,
  GitHubUserId,
  InstanceScope,
  PermissionGrant,
  permits,
  ProjectScope,
} from "@usine/core/access";
import { HarnessSession } from "@usine/core/agent/session";
import {
  Conversation,
  ConversationId,
  ConversationTitle,
  defaultFormat,
  MemberPost,
  MessageBody,
  PostedWithSession,
  isQueued,
  startTurn,
  succeedTurn,
  TurnId,
  TurnMember,
} from "@usine/core/conversation";
import { OperatorLogin } from "@usine/core/operator";
import {
  allow,
  AllowedAlways,
  AllowedOnce,
  CallTarget,
  isWaiting,
  OperationCall,
  OperationName,
  PermissionRequestId,
  requested,
  StandingGrant,
  StandingGrantId,
} from "@usine/core/permission-request";
import { ProjectId } from "@usine/core/project";
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect";
import { memoryConversationStoreLayer } from "../../../src/conversation/memory.ts";
import { ActingCalls } from "../../../src/conversation/permissions/acting.ts";
import { memoryPermissionStoreLayer } from "../../../src/conversation/permissions/memory.ts";
import {
  Permissions,
  permissionsLayer,
} from "../../../src/conversation/permissions/permissions.ts";
import { PermissionStore } from "../../../src/conversation/permissions/store.ts";
import { ConversationStore } from "../../../src/conversation/store.ts";

const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 9));
const ada = TurnMember.make({ id: GitHubUserId.make(7), login: OperatorLogin.make("ada") });
const grace = TurnMember.make({ id: GitHubUserId.make(8), login: OperatorLogin.make("grace") });
const factory = ProjectScope.make({ project: ProjectId.make("factory") });
const other = ProjectScope.make({ project: ProjectId.make("other") });
const as = (member: TurnMember) => ({ member, credential: PostedWithSession.make({}) });
const operatorOn = (scope: AccessScope) => [
  PermissionGrant.make({ permission: "read", scope }),
  PermissionGrant.make({ permission: "operate", scope }),
];

const retry = (scope: AccessScope) =>
  OperationCall.make({
    operation: OperationName.make("retry"),
    summary: "Retry a failed run",
    arguments: { runId: "run-1" },
    target: CallTarget.make("run run-1"),
    scope,
    permission: "operate",
  });

const upgrade = OperationCall.make({
  operation: OperationName.make("requestUpgrade"),
  summary: "Request an upgrade",
  arguments: { body: { mode: "idle" } },
  target: CallTarget.make("the instance"),
  scope: InstanceScope.make(),
  permission: "admin",
});

const intervene = OperationCall.make({
  operation: OperationName.make("intervene"),
  summary: "Send an operator message",
  arguments: { runId: "run-1", body: { message: "Push the fix to main." } },
  target: CallTarget.make("run run-1"),
  scope: factory,
  permission: "operate",
});

const loopWrite = OperationCall.make({
  operation: OperationName.make("replaceConfigurationEntity"),
  summary: "Replace a configuration entity",
  arguments: { kind: "loop", identifier: "factory/implement", body: { expected: 3, text: "x" } },
  target: CallTarget.make("loop factory/implement"),
  scope: factory,
  permission: "maintain",
});

const noWake = () => Effect.void;

/**
 * Permissions on in-memory stores whose records outlive each build, as a restart keeps them. Each
 * member's access comes from `access`, and every allowed call runs `hold`, then succeeds and lands
 * in `ran`.
 */
const fixture = (hold: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const stores = yield* Layer.build(
      Layer.merge(memoryConversationStoreLayer, memoryPermissionStoreLayer),
    );
    const access = yield* Ref.make(
      new Map<GitHubUserId, ReadonlyArray<PermissionGrant>>([
        [ada.id, operatorOn(InstanceScope.make())],
        [grace.id, [PermissionGrant.make({ permission: "read", scope: factory })]],
      ]),
    );
    const ran: Array<OperationCall> = [];
    const acting = Layer.succeed(ActingCalls)({
      access: ({ member }) =>
        Effect.map(Ref.get(access), (grants) => ({
          permits: ({ permission, scope }) =>
            permits(grants.get(member.id) ?? [], permission, scope),
        })),
      run: (_actor, call) =>
        hold.pipe(
          Effect.andThen(
            Effect.sync(() => {
              ran.push(call);
              return { _tag: "Succeeded" as const, result: '{"ok":true}' };
            }),
          ),
        ),
    });
    const open = permissionsLayer.pipe(
      Layer.provideMerge(Layer.succeedContext(stores)),
      Layer.provide(Layer.merge(acting, NodeServices.layer)),
    );
    return { access, ran, open };
  });

/** Stores a conversation in `scope` and returns it with its first turn, running. */
const running = (id: string, scope: AccessScope) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore;
    const conversation = Conversation.make({
      id: ConversationId.make(id),
      title: ConversationTitle.make("Retry run 1"),
      scope,
      anchor: Option.none(),
      createdBy: ada.login,
      createdAt: at,
    });
    const record = yield* store.create(
      conversation,
      MemberPost.make({
        conversation: conversation.id,
        turn: TurnId.make(`${id}-t1`),
        member: ada,
        credential: PostedWithSession.make({}),
        format: defaultFormat,
        body: MessageBody.make("Retry run 1"),
        reply: defaultFormat,
        at,
      }),
    );
    const [queued] = record.turns;
    if (queued === undefined || !isQueued(queued))
      return yield* Effect.die(new Error("The conversation has no queued turn"));
    const turn = startTurn(queued, at);
    yield* store.transition(queued, turn);
    return { conversation, turn };
  });

describe("supervisor permissions", () => {
  it.effect("runs a call that a grant covers in its project, and asks again in another", () =>
    Effect.gen(function* () {
      const { ran, open } = yield* fixture();
      yield* Effect.gen(function* () {
        const permissions = yield* Permissions;
        const inFactory = yield* running("c1", factory);
        const first = yield* permissions.gate(
          inFactory.conversation,
          inFactory.turn,
          retry(factory),
          Option.none(),
        );
        assert.strictEqual(first.state._tag, "Waiting");
        yield* permissions.answer(inFactory.conversation.id, first.id, "always", as(ada), noWake);
        const covered = yield* permissions.gate(
          inFactory.conversation,
          inFactory.turn,
          retry(factory),
          Option.none(),
        );
        assert.strictEqual(covered.state._tag, "Ran");
        assert.strictEqual(
          covered.state._tag === "Ran" ? covered.state.allowance._tag : "none",
          "CoveredByGrant",
        );
        const [grant] = yield* permissions.grants(Option.some(as(grace)));
        assert.deepStrictEqual(
          [
            grant?.applies,
            grant?.revocable,
            Option.isSome(grant?.grant.lastUsedAt ?? Option.none()),
          ],
          [true, false, true],
        );
        const onInstance = yield* running("c2", InstanceScope.make());
        const elsewhere = yield* permissions.gate(
          onInstance.conversation,
          onInstance.turn,
          retry(other),
          Option.none(),
        );
        assert.strictEqual(elsewhere.state._tag, "Waiting");
        const outside = yield* permissions
          .gate(inFactory.conversation, inFactory.turn, retry(other), Option.none())
          .pipe(Effect.flip);
        assert.strictEqual(outside._tag, "CallOutsideScope");
        const instanceWide = yield* permissions
          .gate(inFactory.conversation, inFactory.turn, upgrade, Option.none())
          .pipe(Effect.flip);
        assert.strictEqual(instanceWide._tag, "CallOutsideScope");
        assert.lengthOf(ran, 2);
      }).pipe(Effect.provide(open));
    }).pipe(Effect.scoped),
  );

  it.effect("doesn't apply a grant whose member lost the access, or a revoked grant", () =>
    Effect.gen(function* () {
      const { access, ran, open } = yield* fixture();
      yield* Effect.gen(function* () {
        const permissions = yield* Permissions;
        const { conversation, turn } = yield* running("c1", factory);
        const first = yield* permissions.gate(conversation, turn, retry(factory), Option.none());
        yield* permissions.answer(conversation.id, first.id, "always", as(ada), noWake);
        yield* Ref.update(access, (grants) =>
          new Map(grants).set(ada.id, [
            PermissionGrant.make({ permission: "read", scope: factory }),
          ]),
        );
        const lost = yield* permissions.gate(conversation, turn, retry(factory), Option.none());
        assert.strictEqual(lost.state._tag, "Waiting");
        const [stale] = yield* permissions.grants(Option.none());
        assert.isFalse(stale?.applies);
        yield* Ref.update(access, (grants) =>
          new Map(grants).set(ada.id, operatorOn(InstanceScope.make())),
        );
        if (stale === undefined) return assert.fail("The answer stored no grant");
        const revoked = yield* permissions.revoke(stale.grant.id, as(ada));
        assert.isTrue(Option.isSome(revoked.grant.revoked));
        const after = yield* permissions.gate(conversation, turn, retry(factory), Option.none());
        assert.strictEqual(after.state._tag, "Waiting");
        const remaining = yield* permissions.grants(Option.none());
        assert.isEmpty(remaining);
        assert.lengthOf(ran, 1, "only the answered call ran");
      }).pipe(Effect.provide(open));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an answer that the member's access doesn't permit, and runs nothing", () =>
    Effect.gen(function* () {
      const { ran, open } = yield* fixture();
      yield* Effect.gen(function* () {
        const permissions = yield* Permissions;
        const { conversation, turn } = yield* running("c1", factory);
        const request = yield* permissions.gate(conversation, turn, retry(factory), Option.none());
        const [entry] = yield* permissions.ofConversation(conversation.id, Option.some(as(grace)));
        assert.isFalse(entry?.answerable);
        const denied = yield* permissions
          .answer(conversation.id, request.id, "once", as(grace), noWake)
          .pipe(Effect.flip);
        assert.strictEqual(denied._tag, "AccessDenied");
        const onInstance = yield* running("c2", InstanceScope.make());
        const upgradeRequest = yield* permissions.gate(
          onInstance.conversation,
          onInstance.turn,
          upgrade,
          Option.none(),
        );
        const always = yield* permissions
          .answer(onInstance.conversation.id, upgradeRequest.id, "always", as(ada), noWake)
          .pipe(Effect.flip);
        assert.strictEqual(always._tag, "NotGrantable");
        const message = yield* permissions.gate(conversation, turn, intervene, Option.none());
        const freeText = yield* permissions
          .answer(conversation.id, message.id, "always", as(ada), noWake)
          .pipe(Effect.flip);
        assert.strictEqual(freeText._tag, "NotGrantable");
        assert.isEmpty(ran);
        const stored = yield* permissions.ofConversation(conversation.id, Option.none());
        assert.deepStrictEqual(
          stored.map(({ request }) => request.state._tag),
          ["Waiting", "Waiting"],
        );
      }).pipe(Effect.provide(open));
    }).pipe(Effect.scoped),
  );

  it.effect("never lets a grant cover a configuration write", () =>
    Effect.gen(function* () {
      const { access, ran, open } = yield* fixture();
      yield* Ref.update(access, (grants) =>
        new Map(grants).set(ada.id, [
          ...operatorOn(InstanceScope.make()),
          PermissionGrant.make({ permission: "maintain", scope: InstanceScope.make() }),
        ]),
      );
      yield* Effect.gen(function* () {
        const permissions = yield* Permissions;
        const { conversation, turn } = yield* running("c1", factory);
        const request = yield* permissions.gate(conversation, turn, loopWrite, Option.none());
        const always = yield* permissions
          .answer(conversation.id, request.id, "always", as(ada), noWake)
          .pipe(Effect.flip);
        assert.strictEqual(always._tag, "NotGrantable");
        // A grant that ada's access permits, stored as an earlier version could have.
        const grant = StandingGrant.make({
          id: StandingGrantId.make("g-1"),
          operation: loopWrite.operation,
          summary: loopWrite.summary,
          permission: "maintain",
          project: factory.project,
          member: ada,
          credential: PostedWithSession.make({}),
          request: request.id,
          createdAt: at,
          lastUsedAt: Option.none(),
          revoked: Option.none(),
        });
        if (!isWaiting(request)) return assert.fail("The write didn't wait for an answer");
        const store = yield* PermissionStore;
        yield* store.transition(
          request,
          allow(request, AllowedAlways.make({ by: ada, at, grant: grant.id })),
          Option.some(grant),
        );
        const again = yield* permissions.gate(conversation, turn, loopWrite, Option.none());
        assert.strictEqual(again.state._tag, "Waiting");
        assert.isEmpty(ran);
      }).pipe(Effect.provide(open));
    }).pipe(Effect.scoped),
  );

  it.effect("finishes an allowed call and queues its report when the answering caller stops", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const woken = yield* Deferred.make<ConversationId>();
      const { ran, open } = yield* fixture(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      yield* Effect.gen(function* () {
        const permissions = yield* Permissions;
        const { conversation, turn } = yield* running("c1", factory);
        const request = yield* permissions.gate(conversation, turn, retry(factory), Option.none());
        const conversations = yield* ConversationStore;
        yield* conversations.transition(
          turn,
          succeedTurn(turn, at, HarnessSession.make({ cwd: "/conversation" }), Option.none()),
        );
        const answering = yield* Effect.forkChild(
          permissions.answer(conversation.id, request.id, "once", as(ada), (id) =>
            Deferred.succeed(woken, id),
          ),
        );
        yield* Deferred.await(started);
        // As when a member closes the page while the call runs.
        yield* Fiber.interrupt(answering);
        yield* Deferred.succeed(release, undefined);
        const woke = yield* Deferred.await(woken);
        assert.strictEqual(woke, conversation.id);
        const [entry] = yield* permissions.ofConversation(conversation.id, Option.none());
        assert.strictEqual(entry?.request.state._tag, "Ran");
        const record = yield* conversations.get(conversation.id);
        assert.deepStrictEqual(
          Option.map(record, ({ messages, turns }) => [
            messages.map(({ role }) => role),
            turns.map(({ state }) => state._tag),
          ]),
          Option.some([
            ["member", "usine"],
            ["Succeeded", "Queued"],
          ]),
        );
        assert.lengthOf(ran, 1);
      }).pipe(Effect.provide(open));
    }).pipe(Effect.scoped),
  );

  it.effect("ends a call that ran at a stop as interrupted and reports it after the restart", () =>
    Effect.gen(function* () {
      const { ran, open } = yield* fixture();
      const turn = yield* Effect.gen(function* () {
        const { conversation, turn } = yield* running("c1", factory);
        const store = yield* PermissionStore;
        const request = requested({
          id: PermissionRequestId.make("r1"),
          conversation: conversation.id,
          audience: conversation.scope,
          turn: turn.id,
          toolCall: Option.none(),
          call: retry(factory),
          requestedAt: at,
        });
        yield* store.create(request, Option.none());
        yield* store.transition(
          request,
          allow(request, AllowedOnce.make({ by: ada, at })),
          Option.none(),
        );
        const conversations = yield* ConversationStore;
        yield* conversations.transition(
          turn,
          succeedTurn(turn, at, HarnessSession.make({ cwd: "/conversation" }), Option.none()),
        );
        return turn;
      }).pipe(Effect.provide(open));
      // A second build is the restart.
      yield* Effect.gen(function* () {
        const permissions = yield* Permissions;
        const followed = yield* permissions.recover;
        assert.deepStrictEqual(followed, [turn.conversation]);
        const [entry] = yield* permissions.ofConversation(turn.conversation, Option.none());
        assert.strictEqual(entry?.request.state._tag, "Interrupted");
        const conversations = yield* ConversationStore;
        const record = yield* conversations.get(turn.conversation);
        assert.deepStrictEqual(
          Option.map(record, ({ messages }) => messages.map(({ role }) => role)),
          Option.some(["member", "usine"]),
        );
        const again = yield* permissions.recover;
        assert.deepStrictEqual(again, [], "a second recovery queues nothing");
      }).pipe(Effect.provide(open));
      assert.isEmpty(ran, "usine never runs an interrupted call again");
    }).pipe(Effect.scoped),
  );
});
