import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  type AccessScope,
  AccessDenied,
  administratorPermissions,
  InstanceScope,
  PermissionGrant,
  ProjectScope,
  type PermissionGrant as Grant,
} from "@usine/core/access";
import {
  Conversation,
  ConversationId,
  ConversationTitle,
  defaultFormat,
  MemberPost,
  MessageBody,
  PostedWithSession,
  TurnId,
  TurnMember,
} from "@usine/core/conversation";
import { ActingMember } from "@usine/core/operator";
import {
  CallTarget,
  callCeiling,
  OperationCall,
  OperationName,
  type PermissionRequest,
  PermissionRequestId,
  requested,
} from "@usine/core/permission-request";
import { ProjectId } from "@usine/core/project";
import type { RunId } from "@usine/core/run";
import { Conversations } from "@usine/orchestrator/conversation";
import { memoryConversationStoreLayer } from "@usine/orchestrator/conversation/memory";
import { Permissions, permissionsLayer } from "@usine/orchestrator/conversation/permissions";
import { memoryPermissionStoreLayer } from "@usine/orchestrator/conversation/permissions/memory";
import { PermissionStore } from "@usine/orchestrator/conversation/permissions/store";
import { ConversationNotFound, ConversationStore } from "@usine/orchestrator/conversation/store";
import { ConfigurationEditor } from "@usine/orchestrator/operator";
import { OperatorApi } from "@usine/orchestrator/operator/http";
import { Context, DateTime, Effect, Layer, Option, Redacted, Result, Schema, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { AuthApi } from "../../src/auth/api.ts";
import { Authentication } from "../../src/auth/authentication.ts";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { OperationId } from "../../src/auth/model.ts";
import { FactoryBackend } from "../../src/backend.ts";
import { apiRoutes } from "../../src/http.ts";
import { catalogPools } from "../../../../packages/orchestrator/test/support/pools.ts";
import { routedOperatorCall } from "../../src/mcp/http.ts";
import { loadOperatorTools, PublishedApi } from "../../src/mcp/tools.ts";
import { operatorOpenApi } from "../../src/openapi.ts";
import { ProviderApi } from "../../src/providers/api.ts";
import { SetupApi } from "../../src/setup/api.ts";
import { actingCallsLayer } from "../../src/supervisor/acting.ts";
import { turnToolkit } from "../../src/supervisor/turns.ts";
import { alice, authFixture } from "../auth/fixture.ts";
import { agentText, harness } from "../configuration-http/support.ts";

const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
const beta = ProjectScope.make({ project: ProjectId.make("beta") });
const grant = (permission: "read" | "operate", scope: AccessScope = alpha) =>
  PermissionGrant.make({ permission, scope });
const aliceMember = TurnMember.make({ id: alice.id, login: alice.login });
const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 9));
const approve = OperationCall.make({
  operation: OperationName.make("approve"),
  summary: "Approve a waiting run",
  arguments: { runId: "run-1" },
  target: CallTarget.make("run run-1"),
  scope: alpha,
  permission: "operate",
});

interface MemberGrants {
  current: ReadonlyArray<Grant>;
}

/**
 * The operator API with a backend that records approvals and their actor, alice's role bindings
 * from `grants`, the configuration `editor` if given, and supervisor permissions on in-memory
 * stores. A run `run-1` is in project alpha; any other target can't be read.
 */
const fixture = (
  grants: MemberGrants,
  editor: Layer.Layer<ConfigurationEditor> | Layer.Layer<never> = Layer.empty,
) =>
  Effect.gen(function* () {
    const approvals: Array<{ readonly runId: RunId; readonly actor: Option.Option<string> }> = [];
    const services = yield* authFixture([alice], alice, () => grants.current);
    const link = yield* services.authentication.link;
    const signIn = new URL(link);
    const browser = yield* services.authentication.consumeLink(
      new URLSearchParams(signIn.hash.slice(1)).get("link") ?? "",
    );
    const stores = yield* Layer.build(
      Layer.merge(memoryConversationStoreLayer, memoryPermissionStoreLayer),
    );
    const backend = Layer.mock(FactoryBackend)({
      approve: (runId) =>
        Effect.map(ActingMember, (actor) => {
          approvals.push({ runId, actor });
        }),
      callScope: (target) =>
        target._tag === "Run" && target.runId === "run-1"
          ? Effect.succeed({ target, scope: alpha })
          : Effect.fail(AccessDenied.make({ permission: "read" })),
    });
    const permissions = permissionsLayer.pipe(
      Layer.provide(actingCallsLayer),
      Layer.provide(Layer.succeedContext(stores)),
      Layer.provide(Layer.succeed(Authentication, services.authentication)),
      Layer.provide(NodeServices.layer),
    );
    // Answers go to the permissions, as the orchestrator's conversations send them.
    const conversations = Layer.unwrap(
      Effect.gen(function* () {
        const current = yield* Permissions;
        const store = yield* ConversationStore;
        return Layer.mock(Conversations)({
          read: (id) =>
            Effect.flatMap(store.get(id), (found) =>
              Effect.fromOption(found).pipe(
                Effect.mapError(() => ConversationNotFound.make({ conversation: id })),
              ),
            ),
          answer: (id, request, answer, by) =>
            current.answer(id, request, answer, by, () => Effect.void),
        });
      }),
    ).pipe(Layer.provide(Layer.succeedContext(stores)));
    const authenticated = authenticatedRoutes(services);
    const routes = Layer.mergeAll(
      apiRoutes.pipe(Layer.provide(catalogPools), Layer.provide(authenticated.guard.layer)),
      authenticated.routes,
    ).pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(backend, editor, Layer.provideMerge(conversations, permissions)),
      ),
    );
    const context = yield* Layer.build(Layer.provideMerge(routes, HttpRouter.layer));
    const router = Context.get(context, HttpRouter.HttpRouter);
    const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi());
    const tools = yield* loadOperatorTools(document);
    const session = browser.secret;
    const request = (secret: Redacted.Redacted<string>) =>
      routedOperatorCall(router, {
        authorization: `Bearer ${Redacted.value(secret)}`,
      });
    const backendService = yield* Layer.build(backend).pipe(
      Effect.map((built) => Context.get(built, FactoryBackend)),
    );
    // A turn's tools in `scope`; each call of a gated tool lands in `calls` as a waiting request.
    const toolsOfTurn = (
      scope: AccessScope,
      ceiling: Option.Option<ReadonlyArray<OperationId>> = Option.none(),
    ) =>
      Effect.gen(function* () {
        const secret = yield* services.authentication.turnCredential(
          alice.id,
          scope,
          PostedWithSession.make({}),
        );
        const calls: Array<OperationCall> = [];
        const toolkit = yield* turnToolkit(
          { tools, router, authentication: services.authentication, backend: backendService },
          secret,
          ceiling,
          {
            call: (call, toolCall) =>
              Effect.sync((): PermissionRequest => {
                calls.push(call);
                return requested({
                  id: PermissionRequestId.make("r-1"),
                  conversation: ConversationId.make("c-1"),
                  audience: scope,
                  turn: TurnId.make("t-1"),
                  toolCall,
                  call,
                  requestedAt: at,
                });
              }),
          },
        );
        // Calls the tool `name` as the model does and returns the text that the model reads.
        const handle = (name: string, params: Schema.Json) =>
          Effect.gen(function* () {
            const built = yield* toolkit.toolkit;
            const result = yield* built
              .handle(name, params, "call-1")
              .pipe(Stream.unwrap, Stream.runLast, Effect.result);
            return Result.isFailure(result)
              ? String(result.failure)
              : Option.match(result.success, {
                  onNone: () => "",
                  onSome: ({ result: text }) => String(text),
                });
          }).pipe(Effect.provide(toolkit.handlers));
        return { names: Object.keys(toolkit.toolkit.tools), handle, calls };
      });
    return { approvals, services, stores, tools, session, request, toolsOfTurn };
  });

/** Stores a conversation in `scope` with a turn, and a waiting request of `call`. */
const waitingRequest = (
  stores: Context.Context<ConversationStore | PermissionStore>,
  call: OperationCall = approve,
  scope: AccessScope = alpha,
) =>
  Effect.gen(function* () {
    const conversations = Context.get(stores, ConversationStore);
    const conversation = Conversation.make({
      id: ConversationId.make("c-1"),
      title: ConversationTitle.make("Approve run 1"),
      scope,
      anchor: Option.none(),
      createdBy: alice.login,
      createdAt: at,
    });
    yield* conversations.create(
      conversation,
      MemberPost.make({
        conversation: conversation.id,
        turn: TurnId.make("t-1"),
        member: aliceMember,
        credential: PostedWithSession.make({}),
        format: defaultFormat,
        body: MessageBody.make("Approve run 1"),
        reply: defaultFormat,
        at,
      }),
    );
    const request = requested({
      id: PermissionRequestId.make("r-1"),
      conversation: conversation.id,
      audience: scope,
      turn: TurnId.make("t-1"),
      toolCall: Option.some("call-1"),
      call,
      requestedAt: at,
    });
    yield* Context.get(stores, PermissionStore).create(request, Option.none());
    return request;
  });

describe("a supervisor turn's calls that need more than read", () => {
  it.effect("go to the turn's requests and never run with the turn's credential", () =>
    Effect.gen(function* () {
      const grants: MemberGrants = { current: [grant("read"), grant("operate")] };
      const { approvals, tools, toolsOfTurn } = yield* fixture(grants);
      const { names, handle, calls } = yield* toolsOfTurn(alpha);
      const operations = tools
        .filter(({ name }) => names.includes(name))
        .map(({ operationId }) => operationId);
      const refused = [
        ...Object.keys(AuthApi.endpoints).map((name) => `${AuthApi.identifier}.${name}`),
        ...Object.keys(SetupApi.endpoints).map((name) => `${SetupApi.identifier}.${name}`),
        ...Object.keys(ProviderApi.endpoints).map((name) => `${ProviderApi.identifier}.${name}`),
        ...Object.keys(OperatorApi.groups.conversation.endpoints).map(
          (name) => `conversation.${name}`,
        ),
      ];
      assert.lengthOf(operations, names.length);
      assert.isTrue(operations.every((operation) => operation.startsWith("operator.")));
      assert.isEmpty(
        operations.filter((operation) => refused.includes(operation)),
        "members, tokens, logins, setup, authentication, and conversations have no tool",
      );
      assert.include(names, "approve");
      const stored = yield* handle("approve", { runId: "run-1" });
      assert.include(stored, "stored permission request r-1");
      assert.deepStrictEqual<ReadonlyArray<ReadonlyArray<unknown>>>(
        calls.map(({ operation, target, scope }) => [operation, target, scope]),
        [["approve", "run run-1", alpha]],
      );
      const elsewhere = yield* handle("approve", { runId: "run-9" });
      assert.strictEqual(elsewhere, "The run of the call was not found.");
      const binding = yield* handle("replaceConfigurationEntity", {
        kind: "binding",
        identifier: "escalate",
        body: {
          expected: 1,
          value: { name: "escalate", member: 1, role: "admin", scope: { _tag: "Instance" } },
        },
      });
      assert.include(binding, "Role bindings are member access");
      assert.lengthOf(calls, 1, "an unreadable target or a role binding makes no request");
      assert.isEmpty(approvals, "nothing ran");
    }).pipe(Effect.scoped),
  );

  it.effect("are offered only within the posting token's operation ceiling", () =>
    Effect.gen(function* () {
      const { toolsOfTurn } = yield* fixture({ current: [grant("read"), grant("operate")] });
      const { names } = yield* toolsOfTurn(
        alpha,
        Option.some([OperationId.make("operator.approve")]),
      );
      assert.include(names, "approve");
      assert.notInclude(names, "retry");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "run once as the member who allowed them, after a 403 for a member without access",
    () =>
      Effect.gen(function* () {
        const grants: MemberGrants = { current: [grant("read")] };
        const { approvals, request, session, stores } = yield* fixture(grants);
        const waiting = yield* waitingRequest(stores);
        const answer = (body: Schema.Json) =>
          request(session)({
            method: "POST",
            url: `/api/conversations/c-1/requests/${waiting.id}/answer`,
            body: Option.some(body),
          });
        const read = yield* request(session)({
          method: "GET",
          url: "/api/conversations/c-1",
          body: Option.none(),
        });
        assert.include(read.text, '"answerable":false');
        const forbidden = yield* answer({ answer: "once" });
        assert.strictEqual(forbidden.status, 403);
        assert.isEmpty(approvals);
        grants.current = [grant("read"), grant("operate")];
        const allowed = yield* answer({ answer: "always" });
        assert.strictEqual(allowed.status, 200);
        assert.include(allowed.text, '"_tag":"Ran"');
        assert.deepStrictEqual(approvals, [{ runId: "run-1", actor: Option.some("alice") }]);
        const again = yield* answer({ answer: "once" });
        assert.strictEqual(again.status, 409);
        assert.lengthOf(approvals, 1, "a second answer runs nothing");
        const listed = yield* request(session)({
          method: "GET",
          url: "/api/supervisor/grants",
          body: Option.none(),
        });
        assert.include(listed.text, '"applies":true,"revocable":true');
        assert.notInclude(listed.text, "credential");
        grants.current = [grant("read")];
        const refusedRevoke = yield* request(session)({
          method: "DELETE",
          url: `/api/supervisor/grants/${waiting.id}:grant`,
          body: Option.none(),
        });
        assert.strictEqual(refusedRevoke.status, 403);
        const actions = yield* request(session)({
          method: "GET",
          url: "/api/supervisor/actions",
          body: Option.none(),
        });
        assert.include(actions.text, '"AllowedAlways"');
      }).pipe(Effect.scoped),
  );

  it.effect("run with a credential that can call only the allowed operation in its scope", () =>
    Effect.gen(function* () {
      const member = [grant("read"), grant("operate"), grant("read", beta), grant("operate", beta)];
      const { approvals, request, services } = yield* fixture({ current: member });
      const secret = yield* services.authentication.callCredential(
        alice.id,
        PostedWithSession.make({}),
        callCeiling(approve),
        OperationId.make("operator.approve"),
      );
      const access = yield* services.authentication.authenticate(Redacted.value(secret));
      assert.deepStrictEqual(access.permissions, [grant("read"), grant("operate")]);
      const other = yield* request(secret)({
        method: "POST",
        url: "/api/runs/run-1/retry",
        body: Option.none(),
      });
      assert.strictEqual(other.status, 403);
      const members = yield* request(secret)({
        method: "GET",
        url: "/api/members",
        body: Option.none(),
      });
      assert.strictEqual(members.status, 403);
      const allowed = yield* request(secret)({
        method: "POST",
        url: "/api/runs/run-1/approve",
        body: Option.none(),
      });
      assert.strictEqual(allowed.status, 200);
      assert.deepStrictEqual(approvals, [{ runId: "run-1", actor: Option.some("alice") }]);
    }).pipe(Effect.scoped),
  );

  it.effect("change configuration with the permission that the entity's kind needs", () =>
    Effect.gen(function* () {
      const { editor } = yield* harness();
      const { request, session, stores, toolsOfTurn } = yield* fixture(
        { current: administratorPermissions },
        Layer.succeed(ConfigurationEditor, editor),
      );
      const { handle, calls } = yield* toolsOfTurn(InstanceScope.make());
      yield* handle("replaceConfigurationEntity", {
        kind: "agent",
        identifier: "developer",
        body: { expected: 1, text: agentText.replace("Implement.", "Implement carefully.") },
      });
      const [call] = calls;
      if (call === undefined) return assert.fail("The write stored no request");
      assert.deepStrictEqual([call.permission, call.scope], ["admin", InstanceScope.make()]);
      const waiting = yield* waitingRequest(stores, call, InstanceScope.make());
      const answered = yield* request(session)({
        method: "POST",
        url: `/api/conversations/c-1/requests/${waiting.id}/answer`,
        body: Option.some({ answer: "once" }),
      });
      assert.include(answered.text, '"_tag":"Ran"');
      const read = yield* request(session)({
        method: "GET",
        url: "/api/configuration/entities/agent/developer",
        body: Option.none(),
      });
      assert.include(read.text, "Implement carefully.");
    }).pipe(Effect.scoped),
  );
});
