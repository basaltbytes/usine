import { assert, describe, it } from "@effect/vitest";
import { PermissionGrant, ProjectScope, type PermissionGrant as Grant } from "@usine/core/access";
import { ActingMember } from "@usine/core/operator";
import { ProjectId } from "@usine/core/project";
import type { RunId } from "@usine/core/run";
import { operatorPermissions } from "@usine/orchestrator/operator/http";
import { Context, Effect, Layer, Option, Redacted, Result, Schema, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { OperationId, TokenName } from "../../src/auth/model.ts";
import { FactoryBackend } from "../../src/backend.ts";
import { apiRoutes } from "../../src/http.ts";
import { routedOperatorCall } from "../../src/mcp/http.ts";
import { loadOperatorTools, PublishedApi } from "../../src/mcp/tools.ts";
import { operatorOpenApi } from "../../src/openapi.ts";
import { memberOperatorToolkit, operatorToolkit } from "../../src/supervisor/toolkit.ts";
import { authFixture } from "../auth/fixture.ts";

const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
const grant = (permission: "read" | "operate") =>
  PermissionGrant.make({ permission, scope: alpha });

/** The operator tools that a member with `permissions` may call. */
const permitted = (permissions: ReadonlyArray<"public" | "read" | "operate">) =>
  Object.entries(operatorPermissions)
    .filter(
      ([name, permission]) =>
        name !== "changes" && permissions.some((allowed) => allowed === permission),
    )
    .map(([name]) => name);

const fixture = Effect.gen(function* () {
  const approvals: Array<{ readonly runId: RunId; readonly actor: Option.Option<string> }> = [];
  const services = yield* authFixture();
  const current = yield* services.authentication.link;
  const link = new URL(current);
  const browser = yield* services.authentication.consumeLink(
    new URLSearchParams(link.hash.slice(1)).get("link") ?? "",
  );
  const session = Redacted.value(browser.secret);
  const token = Effect.fn(function* (
    scopes: ReadonlyArray<Grant>,
    operations: Option.Option<ReadonlyArray<OperationId>> = Option.none(),
  ) {
    const issued = yield* services.authentication.createToken(session, {
      name: TokenName.make("Supervisor"),
      scopes,
      operations,
      expiresAt: Option.none(),
    });
    return issued.secret;
  });
  const backend = Layer.mock(FactoryBackend)({
    approve: (runId) =>
      Effect.map(ActingMember, (actor) => {
        approvals.push({ runId, actor });
      }),
  });
  const authenticated = authenticatedRoutes(services);
  const routes = Layer.mergeAll(
    apiRoutes.pipe(Layer.provide(authenticated.guard.layer)),
    authenticated.routes,
  ).pipe(HttpRouter.provideRequest(backend));
  const context = yield* Layer.build(Layer.provideMerge(routes, HttpRouter.layer));
  const router = Context.get(context, HttpRouter.HttpRouter);
  const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi());
  const tools = yield* loadOperatorTools(document);
  return { approvals, router, services, token, tools };
});

/**
 * Calls `name` on `toolkit` with its handlers, as a harness does for the model, and returns
 * whether the call failed, and the text that the model reads.
 */
const call = (toolkit: ReturnType<typeof operatorToolkit>, name: string, params: Schema.Json) =>
  Effect.gen(function* () {
    const built = yield* toolkit.toolkit;
    const last = yield* built
      .handle(name, params)
      .pipe(Stream.unwrap, Stream.runLast, Effect.result);
    if (Result.isFailure(last)) return { isFailure: true, text: String(last.failure) };
    assert(Option.isSome(last.success), `${name} returned a result`);
    return { isFailure: false, text: String(last.success.value.result) };
  }).pipe(Effect.provide(toolkit.handlers));

describe("the supervisor's operator toolkit", () => {
  it.effect("lists only the operator tools that the member's token permits", () =>
    Effect.gen(function* () {
      const { router, services, token, tools } = yield* fixture;
      const readerToken = yield* token([grant("read")]);
      const reader = yield* memberOperatorToolkit(
        readerToken,
        tools,
        router,
        services.authentication,
      );
      assert.sameMembers(Object.keys(reader.toolkit.tools), permitted(["public", "read"]));
      assert.notProperty(reader.toolkit.tools, "approve");
      const operatorToken = yield* token([grant("read"), grant("operate")]);
      const operator = yield* memberOperatorToolkit(
        operatorToken,
        tools,
        router,
        services.authentication,
      );
      assert.sameMembers(
        Object.keys(operator.toolkit.tools),
        permitted(["public", "read", "operate"]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("lists only the operator tools within the token's operation ceiling", () =>
    Effect.gen(function* () {
      const { approvals, router, services, token, tools } = yield* fixture;
      const grants = [grant("read"), grant("operate")];
      const overviewToken = yield* token(
        grants,
        Option.some([OperationId.make("operator.overview")]),
      );
      const overview = yield* memberOperatorToolkit(
        overviewToken,
        tools,
        router,
        services.authentication,
      );
      assert.sameMembers(Object.keys(overview.toolkit.tools), ["overview"]);
      const noneToken = yield* token(grants, Option.some([]));
      const none = yield* memberOperatorToolkit(noneToken, tools, router, services.authentication);
      assert.isEmpty(Object.keys(none.toolkit.tools));

      // The ceiling still binds a toolkit that lists every operator tool.
      const unfiltered = operatorToolkit(
        tools,
        routedOperatorCall(router, { authorization: `Bearer ${Redacted.value(overviewToken)}` }),
      );
      const refused = yield* call(unfiltered, "approve", { runId: "run-3" });
      assert.isTrue(refused.isFailure);
      assert.match(refused.text, /^HTTP 403\n/u);
      assert.isEmpty(approvals, "the ceiling token approved nothing");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "acts with the member's token and refuses a write that a read-only token can't make",
    () =>
      Effect.gen(function* () {
        const { approvals, router, services, token, tools } = yield* fixture;
        const operatorToken = yield* token([grant("read"), grant("operate")]);
        const operator = yield* memberOperatorToolkit(
          operatorToken,
          tools,
          router,
          services.authentication,
        );
        const approved = yield* call(operator, "approve", { runId: "run-1" });
        assert.deepStrictEqual(approved, { isFailure: false, text: '{"ok":true}' });
        assert.deepStrictEqual(approvals, [{ runId: "run-1", actor: Option.some("alice") }]);

        // Even a toolkit that lists every operator tool acts with the read-only token, so the
        // route policy refuses the write and the model reads the refusal as an error result.
        const readerToken = yield* token([grant("read")]);
        const unfiltered = operatorToolkit(
          tools,
          routedOperatorCall(router, { authorization: `Bearer ${Redacted.value(readerToken)}` }),
        );
        const refused = yield* call(unfiltered, "approve", { runId: "run-2" });
        assert.isTrue(refused.isFailure);
        assert.match(refused.text, /^HTTP 403\n/u);
        assert.lengthOf(approvals, 1, "the read-only token approved nothing");

        const invalid = yield* call(operator, "approve", {});
        assert.deepStrictEqual(invalid, { isFailure: true, text: "Pass runId as a string." });
      }).pipe(Effect.scoped),
  );
});
