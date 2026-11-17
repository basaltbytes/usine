import { assert, describe, it } from "@effect/vitest";
import {
  administratorPermissions,
  InstanceScope,
  PermissionGrant,
  ProjectScope,
  TokenId,
  type PermissionGrant as Grant,
} from "@usine/core/access";
import {
  Conversation,
  ConversationId,
  ConversationTitle,
  defaultFormat,
  MemberPost,
  MessageBody,
  MessageSequence,
  PostedWithSession,
  PostedWithToken,
  type PostingCredential,
  posted,
  TurnId,
  TurnMember,
} from "@usine/core/conversation";
import { ProjectId } from "@usine/core/project";
import { TurnAccess } from "@usine/orchestrator/conversation/access";
import { Conversations, SupervisorReady } from "@usine/orchestrator/conversation";
import { ConversationRecord, Posted } from "@usine/orchestrator/conversation/store";
import { OperatorApi } from "@usine/orchestrator/operator/http";
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { Authentication } from "../../src/auth/authentication.ts";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { OperationId, TokenName } from "../../src/auth/model.ts";
import { FactoryBackend } from "../../src/backend.ts";
import { apiRoutes } from "../../src/http.ts";
import { routedOperatorCall } from "../../src/mcp/http.ts";
import { loadOperatorTools, PublishedApi } from "../../src/mcp/tools.ts";
import { operatorOpenApi } from "../../src/openapi.ts";
import { memberOperatorToolkit } from "../../src/supervisor/toolkit.ts";
import { turnAccessLayer } from "../../src/supervisor/turns.ts";
import { alice, authFixture } from "../auth/fixture.ts";

const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
const grant = (permission: "read" | "operate") =>
  PermissionGrant.make({ permission, scope: alpha });
const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 17, 9));
const conversation = Conversation.make({
  id: ConversationId.make("c-1"),
  title: ConversationTitle.make("What needs me?"),
  scope: alpha,
  anchor: Option.none(),
  createdBy: alice.login,
  createdAt: at,
});
const aliceMember = TurnMember.make({ id: alice.id, login: alice.login });
const postOf = (member: TurnMember, credential: PostingCredential, sequence: number) =>
  posted(
    MemberPost.make({
      conversation: conversation.id,
      turn: TurnId.make(`t-${sequence}`),
      member,
      credential,
      format: defaultFormat,
      body: MessageBody.make("What needs me?"),
      reply: defaultFormat,
      at,
    }),
    MessageSequence.make(sequence),
  );

interface MemberGrants {
  current: ReadonlyArray<Grant>;
}

/** An operator API with a fake conversation service; `grants` are the member's, changeable. */
const fixture = (grants: MemberGrants = { current: administratorPermissions }) =>
  Effect.gen(function* () {
    const posts: Array<PostingCredential> = [];
    const services = yield* authFixture([alice], alice, () => grants.current);
    const signIn = yield* services.authentication.link;
    const link = new URL(signIn);
    const browser = yield* services.authentication.consumeLink(
      new URLSearchParams(link.hash.slice(1)).get("link") ?? "",
    );
    let issued = 0;
    const token = Effect.fn(function* (
      scopes: ReadonlyArray<Grant>,
      operations: Option.Option<ReadonlyArray<OperationId>> = Option.none(),
    ) {
      issued += 1;
      const name = TokenName.make(`Client ${issued}`);
      const created = yield* services.authentication.createToken(Redacted.value(browser.secret), {
        name,
        scopes,
        operations,
        expiresAt: Option.none(),
      });
      const tokens = yield* services.store.tokens(alice.id);
      const stored = tokens.find((candidate) => candidate.name === name);
      if (stored === undefined) return yield* Effect.die(new Error("The token was not stored"));
      return { secret: created.secret, id: stored.id };
    });
    const first = postOf(
      aliceMember,
      PostedWithToken.make({ tokenId: TokenId.make("stored-token-id") }),
      1,
    );
    const conversations = Layer.mock(Conversations)({
      status: Effect.succeed(SupervisorReady.make({})),
      read: () =>
        Effect.succeed(
          ConversationRecord.make({ conversation, messages: [first.message], turns: [first.turn] }),
        ),
      post: (_id, _message, { member, credential }) =>
        Effect.sync(() => {
          posts.push(credential);
          const next = postOf(member, credential, 2);
          return Posted.make({ message: next.message, turn: next.turn });
        }),
    });
    const authenticated = authenticatedRoutes(services);
    const routes = Layer.mergeAll(
      apiRoutes.pipe(Layer.provide(authenticated.guard.layer)),
      authenticated.routes,
    ).pipe(HttpRouter.provideRequest(Layer.merge(Layer.mock(FactoryBackend)({}), conversations)));
    const context = yield* Layer.build(Layer.provideMerge(routes, HttpRouter.layer));
    const router = Context.get(context, HttpRouter.HttpRouter);
    const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi());
    const tools = yield* loadOperatorTools(document);
    const request = (secret: Redacted.Redacted<string>) =>
      routedOperatorCall(router, { authorization: `Bearer ${Redacted.value(secret)}` });
    // Built on demand: loading the operator tools again is slow.
    const turnAccess = Layer.build(
      turnAccessLayer.pipe(
        Layer.provide(Layer.succeed(HttpRouter.HttpRouter, router)),
        Layer.provide(Layer.succeed(Authentication, services.authentication)),
      ),
    ).pipe(Effect.map((context) => Context.get(context, TurnAccess)));
    return {
      posts,
      request,
      router,
      services,
      token,
      tools,
      turnAccess,
    };
  });

const message = { body: "And then?" };

describe("conversations over the operator API", () => {
  it.effect(
    "lets a viewer read a project conversation, refuses its post, and takes an operator's",
    () =>
      Effect.gen(function* () {
        const { posts, request, token } = yield* fixture();
        const viewer = yield* token([grant("read")]);
        const read = yield* request(viewer.secret)({
          method: "GET",
          url: "/api/conversations/c-1",
          body: Option.none(),
        });
        assert.strictEqual(read.status, 200);
        const refused = yield* request(viewer.secret)({
          method: "POST",
          url: "/api/conversations/c-1/messages",
          body: Option.some(message),
        });
        assert.strictEqual(refused.status, 403);
        assert.isEmpty(posts);
        const operator = yield* token([grant("read"), grant("operate")]);
        const accepted = yield* request(operator.secret)({
          method: "POST",
          url: "/api/conversations/c-1/messages",
          body: Option.some(message),
        });
        assert.strictEqual(accepted.status, 200);
        assert.deepStrictEqual(posts, [PostedWithToken.make({ tokenId: operator.id })]);
      }).pipe(Effect.scoped),
  );

  it.effect("records the posting token by ID and leaves it out of every response", () =>
    Effect.gen(function* () {
      const { posts, request, token } = yield* fixture();
      const operator = yield* token([grant("read"), grant("operate")]);
      const accepted = yield* request(operator.secret)({
        method: "POST",
        url: "/api/conversations/c-1/messages",
        body: Option.some(message),
      });
      const read = yield* request(operator.secret)({
        method: "GET",
        url: "/api/conversations/c-1",
        body: Option.none(),
      });
      assert.deepStrictEqual([accepted.status, read.status], [200, 200]);
      assert.deepStrictEqual(posts, [PostedWithToken.make({ tokenId: operator.id })]);
      for (const response of [accepted, read]) {
        for (const leak of ["credential", "tokenId", "PostedWith", "stored-token-id", operator.id])
          assert.notInclude(response.text, leak);
        assert.include(response.text, '"member":{"id":1,"login":"alice"}');
      }
    }).pipe(Effect.scoped),
  );
});

describe("a supervisor turn's credential", () => {
  it.effect("lists and calls only read operations, within the posting token's ceiling", () =>
    Effect.gen(function* () {
      const { request, router, services, token, tools } = yield* fixture();
      const poster = yield* token(
        [grant("read"), grant("operate")],
        Option.some([OperationId.make("operator.overview"), OperationId.make("operator.approve")]),
      );
      const secret = yield* services.authentication.turnCredential(
        alice.id,
        alpha,
        PostedWithToken.make({ tokenId: poster.id }),
      );
      const toolkit = yield* memberOperatorToolkit(secret, tools, router, services.authentication);
      assert.sameMembers(Object.keys(toolkit.toolkit.tools), ["overview"]);
      const approve = yield* request(secret)({
        method: "POST",
        url: "/api/runs/run-1/approve",
        body: Option.none(),
      });
      assert.strictEqual(approve.status, 403);
    }).pipe(Effect.scoped),
  );

  it.effect("is refused on every operation that needs more than read, even for an admin", () =>
    Effect.gen(function* () {
      const { request, router, services, tools } = yield* fixture();
      for (const scope of [alpha, InstanceScope.make()]) {
        const secret = yield* services.authentication.turnCredential(
          alice.id,
          scope,
          PostedWithSession.make({}),
        );
        const access = yield* services.authentication.authenticate(Redacted.value(secret));
        assert.deepStrictEqual(access.permissions, [
          PermissionGrant.make({ permission: "read", scope }),
        ]);
        const toolkit = yield* memberOperatorToolkit(
          secret,
          tools,
          router,
          services.authentication,
        );
        const listed = tools.filter(({ name }) => name in toolkit.toolkit.tools);
        assert.isNotEmpty(listed);
        assert.isTrue(
          listed.every(({ permission }) => permission === "read" || permission === "public"),
        );
        const writes = tools.filter(
          ({ permission }) => permission !== "read" && permission !== "public",
        );
        assert.isNotEmpty(writes);
        for (const tool of writes) {
          const response = yield* request(secret)({
            method: tool.method,
            url: tool.path.replaceAll(/\{[^}]+\}/gu, "x"),
            body: tool.hasBody ? Option.some({}) : Option.none(),
          });
          assert.strictEqual(response.status, 403, `${tool.method} ${tool.path}`);
        }
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reads only the project of a project conversation", () =>
    Effect.gen(function* () {
      const { request, services } = yield* fixture();
      const secret = yield* services.authentication.turnCredential(
        alice.id,
        alpha,
        PostedWithSession.make({}),
      );
      const elsewhere = yield* request(secret)({
        method: "GET",
        url: "/api/projects/beta",
        body: Option.none(),
      });
      assert.strictEqual(elsewhere.status, 403);
    }).pipe(Effect.scoped),
  );

  it.effect("is refused on every conversation endpoint", () =>
    Effect.gen(function* () {
      const { posts, request, services } = yield* fixture();
      const secret = yield* services.authentication.turnCredential(
        alice.id,
        alpha,
        PostedWithSession.make({}),
      );
      const endpoints = Object.values(OperatorApi.groups.conversation.endpoints);
      assert.lengthOf(endpoints, 7);
      for (const endpoint of endpoints) {
        const url = endpoint.path.replace(":conversation", "c-1").replace(":turn", "t-1");
        const response = yield* request(secret)({
          method: endpoint.method === "POST" ? "POST" : "GET",
          url,
          body:
            endpoint.method === "POST"
              ? Option.some(
                  url === "/api/conversations"
                    ? { scope: { _tag: "Project", project: "alpha" }, message }
                    : message,
                )
              : Option.none(),
        });
        assert.strictEqual(response.status, 403, `${endpoint.method} ${url}`);
      }
      assert.isEmpty(posts);
    }).pipe(Effect.scoped),
  );

  it.effect("stops working for a running turn once the posting token is revoked", () =>
    Effect.gen(function* () {
      const { request, services, token } = yield* fixture();
      const poster = yield* token([grant("read"), grant("operate")]);
      const secret = yield* services.authentication.turnCredential(
        alice.id,
        alpha,
        PostedWithToken.make({ tokenId: poster.id }),
      );
      const before = yield* services.authentication.authenticate(Redacted.value(secret));
      assert.deepStrictEqual(before.permissions, [grant("read")]);
      yield* token([grant("read"), grant("operate")]);
      yield* services.store.revoke(alice.id, poster.id);
      const refused = yield* services.authentication
        .authenticate(Redacted.value(secret))
        .pipe(Effect.flip);
      assert.strictEqual(refused.status, 403);
      const call = yield* request(secret)({
        method: "GET",
        url: "/api/overview",
        body: Option.none(),
      });
      assert.strictEqual(call.status, 403);
    }).pipe(Effect.scoped),
  );

  it.effect("follows the member's current grants for a running turn", () =>
    Effect.gen(function* () {
      const grants: MemberGrants = { current: [grant("read"), grant("operate")] };
      const { services } = yield* fixture(grants);
      const secret = yield* services.authentication.turnCredential(
        alice.id,
        alpha,
        PostedWithSession.make({}),
      );
      const before = yield* services.authentication.authenticate(Redacted.value(secret));
      assert.deepStrictEqual(before.permissions, [grant("read")]);
      grants.current = [];
      const after = yield* services.authentication.authenticate(Redacted.value(secret));
      assert.deepStrictEqual(after.permissions, []);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a queued turn whose token was revoked, and reports reduced grants", () =>
    Effect.gen(function* () {
      const grants: MemberGrants = { current: [grant("read"), grant("operate")] };
      const { services, token, turnAccess: openTurnAccess } = yield* fixture(grants);
      const turnAccess = yield* openTurnAccess;
      const poster = yield* token([grant("read"), grant("operate")]);
      // Another live token of the member doesn't keep a revoked one's turns going.
      yield* token([grant("read"), grant("operate")]);
      yield* services.store.revoke(alice.id, poster.id);
      const revoked = yield* turnAccess
        .open(aliceMember, PostedWithToken.make({ tokenId: poster.id }), alpha)
        .pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(
        revoked.message,
        "The token that posted this message was revoked or expired.",
      );
      grants.current = [grant("read")];
      const reduced = yield* services.authentication.postingAccess(
        alice.id,
        PostedWithSession.make({}),
      );
      assert.deepStrictEqual(reduced.permissions, [grant("read")]);
    }).pipe(Effect.scoped),
  );

  it.effect("ends with its scope", () =>
    Effect.gen(function* () {
      const { services } = yield* fixture();
      const secret = yield* Effect.scoped(
        services.authentication
          .turnCredential(alice.id, alpha, PostedWithSession.make({}))
          .pipe(Effect.map(Redacted.value)),
      );
      const refused = yield* services.authentication.authenticate(secret).pipe(Effect.flip);
      assert.strictEqual(refused.status, 401);
    }).pipe(Effect.scoped),
  );
});
