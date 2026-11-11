import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  administratorPermissions,
  PermissionGrant,
  ProjectScope,
  type PermissionGrant as Grant,
} from "@usine/core/access";
import { jsonKey } from "@usine/core/json-key";
import { ActingMember } from "@usine/core/operator";
import { ProjectId } from "@usine/core/project";
import { type RunId } from "@usine/core/run";
import { OperatorApi, operatorPermissions } from "@usine/orchestrator/operator/http";
import {
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { OperationId, TokenName } from "../../src/auth/model.ts";
import { FactoryBackend } from "../../src/backend.ts";
import { apiRoutes } from "../../src/http.ts";
import { MCP_PATH, mcpRoutes } from "../../src/mcp/http.ts";
import { stdioServer } from "../../src/mcp/stdio.ts";
import { authFixture } from "../auth/fixture.ts";

const alpha = ProjectScope.make({ project: ProjectId.make("alpha") });
const grant = (permission: "read" | "operate") =>
  PermissionGrant.make({ permission, scope: alpha });

type JsonObject = Schema.JsonObject;

const ToolList = Schema.Struct({
  result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
});
const ToolCall = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optionalKey(Schema.Boolean),
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  }),
});
const RpcError = Schema.Struct({
  error: Schema.Struct({ code: Schema.Finite, message: Schema.String }),
});
const Message = Schema.Struct({ id: Schema.optionalKey(Schema.Finite) });

/** The tool names a grant set should list: public tools and tools of each granted permission. */
const expectedTools = (permissions: ReadonlyArray<"public" | "read" | "operate">) =>
  Object.entries(operatorPermissions)
    .filter(
      ([name, permission]) =>
        name !== "changes" && permissions.some((allowed) => allowed === permission),
    )
    .map(([name]) => name);

const fixture = Effect.gen(function* () {
  const approvals: Array<{ readonly runId: RunId; readonly actor: Option.Option<string> }> = [];
  const services = yield* authFixture();
  const auth = services.authentication;
  const currentLink = yield* auth.link;
  const link = new URL(currentLink);
  const browser = yield* auth.consumeLink(
    new URLSearchParams(link.hash.slice(1)).get("link") ?? "",
  );
  const session = Redacted.value(browser.secret);
  const device = Effect.fn(function* (
    scopes: ReadonlyArray<Grant>,
    operations: Option.Option<ReadonlyArray<OperationId>> = Option.none(),
  ) {
    const issued = yield* auth.createToken(session, {
      name: TokenName.make("Agent"),
      scopes,
      operations,
      expiresAt: Option.none(),
    });
    return Redacted.value(issued.secret);
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
    mcpRoutes([]).pipe(
      Layer.provide(authenticated.guard.layer),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    authenticated.routes,
  ).pipe(HttpRouter.provideRequest(backend));
  const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
  return { app, routes, device, approvals };
});

/** A JSON-RPC client of `POST /api/mcp` that keeps the session the server assigns. */
const mcpClient = (
  app: { readonly handler: (request: Request) => Promise<Response> },
  token: string,
) => {
  let session: string | undefined;
  let id = 0;
  const post = (body: JsonObject) =>
    Effect.promise(() => {
      const headers = new Headers({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      });
      if (session !== undefined) {
        headers.set("mcp-session-id", session);
        headers.set("mcp-protocol-version", "2025-06-18");
      }
      return app.handler(
        new Request(`https://usine.example${MCP_PATH}`, {
          method: "POST",
          headers,
          body: jsonKey(body),
        }),
      );
    }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          session ??= response.headers.get("mcp-session-id") ?? undefined;
        }),
      ),
    );
  const request = (method: string, params: JsonObject = {}) =>
    post({ jsonrpc: "2.0", id: ++id, method, params }).pipe(
      Effect.flatMap((response) => Effect.promise(() => response.json())),
    );
  const initialize = request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  }).pipe(
    Effect.andThen(post({ jsonrpc: "2.0", method: "notifications/initialized" })),
    Effect.tap((response) => Effect.sync(() => assert.equal(response.status, 202))),
  );
  const listTools = request("tools/list").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ToolList)),
    Effect.map(({ result }) => result.tools.map(({ name }) => name)),
  );
  const call = (name: string, args: JsonObject) => request("tools/call", { name, arguments: args });
  return { initialize, listTools, call };
};

describe("operator MCP endpoint", () => {
  it.live("lists the tools that each token's grants and operation ceiling permit", () =>
    Effect.gen(function* () {
      const { app, device } = yield* fixture;
      const viewerToken = yield* device([grant("read")]);
      const viewer = mcpClient(app, viewerToken);
      yield* viewer.initialize;
      const viewerTools = yield* viewer.listTools;
      assert.sameMembers(viewerTools, expectedTools(["public", "read"]));
      const operatorToken = yield* device([grant("read"), grant("operate")]);
      const operator = mcpClient(app, operatorToken);
      yield* operator.initialize;
      const operatorTools = yield* operator.listTools;
      assert.sameMembers(operatorTools, expectedTools(["public", "read", "operate"]));
      const ceilingToken = yield* device(
        administratorPermissions,
        Option.some([OperationId.make("operator.detail"), OperationId.make("operator.approve")]),
      );
      const ceiling = mcpClient(app, ceilingToken);
      yield* ceiling.initialize;
      const ceilingTools = yield* ceiling.listTools;
      assert.sameMembers(ceilingTools, ["detail", "approve"]);
      for (const name of [...viewerTools, ...operatorTools, ...ceilingTools])
        assert.property(OperatorApi.groups.operator.endpoints, name);
    }).pipe(Effect.scoped),
  );

  it.live("approves a waiting run through the tool and records the token's member", () =>
    Effect.gen(function* () {
      const { app, device, approvals } = yield* fixture;
      const token = yield* device([grant("read"), grant("operate")]);
      const client = mcpClient(app, token);
      yield* client.initialize;
      const result = yield* client
        .call("approve", { runId: "run-1" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolCall)));
      assert.isNotTrue(result.result.isError);
      assert.deepEqual(
        result.result.content.map(({ text }) => text),
        ['{"ok":true}'],
      );
      assert.deepEqual(approvals, [{ runId: "run-1", actor: Option.some("alice") }]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses calls outside the token's ceiling over HTTP and over the tool", () =>
    Effect.gen(function* () {
      const { app, device, approvals } = yield* fixture;
      const token = yield* device(
        administratorPermissions,
        Option.some([OperationId.make("operator.detail")]),
      );
      const http = yield* Effect.promise(() =>
        app.handler(
          new Request("https://usine.example/api/runs/run-1/approve", {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
      );
      assert.equal(http.status, 403);
      const client = mcpClient(app, token);
      yield* client.initialize;
      const refused = yield* client
        .call("approve", { runId: "run-1" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RpcError)));
      assert.include(refused.error.message, "approve");
      const projectToken = yield* device([grant("read"), grant("operate")]);
      const project = mcpClient(app, projectToken);
      yield* project.initialize;
      const otherProject = yield* project
        .call("pauseProjectLoop", { project: "beta", loop: "review" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolCall)));
      assert.isTrue(otherProject.result.isError);
      assert.include(otherProject.result.content[0]?.text ?? "", "HTTP 403");
      assert.deepEqual(approvals, []);
    }).pipe(Effect.scoped),
  );

  it.live("lists the same tools over usine mcp --origin as over /api/mcp for one token", () =>
    Effect.gen(function* () {
      const { app, routes, device } = yield* fixture;
      const token = yield* device([grant("read"), grant("operate")]);
      const overHttp = mcpClient(app, token);
      yield* overHttp.initialize;
      const httpTools = yield* overHttp.listTools;
      const context = yield* Layer.build(NodeHttpServer.layerTest);
      const server = Context.get(context, HttpServer.HttpServer);
      assert.notEqual(server.address._tag, "UnixPathAddress");
      if (server.address._tag === "UnixPathAddress") return;
      const origin = `http://127.0.0.1:${server.address.port}`;
      yield* Layer.build(
        HttpRouter.serve(routes, { disableLogger: true }).pipe(
          Layer.provide(Layer.succeedContext(context)),
        ),
      );
      const input = yield* Queue.unbounded<Uint8Array>();
      const output = yield* Queue.unbounded<string>();
      const encoder = new TextEncoder();
      const send = (message: JsonObject) =>
        Queue.offer(input, encoder.encode(`${jsonKey(message)}\n`));
      let buffered = "";
      const stdio = Stdio.layerTest({
        stdin: Stream.fromQueue(input),
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              buffered += Schema.is(Schema.String)(chunk) ? chunk : new TextDecoder().decode(chunk);
              const lines = buffered.split("\n");
              buffered = lines.pop() ?? "";
              for (const line of lines) if (line !== "") Queue.offerUnsafe(output, line);
            }),
          ),
      });
      yield* Layer.build(
        stdioServer(origin, Redacted.make(token)).pipe(
          Layer.provide(stdio),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        ),
      );
      const reply = (id: number) =>
        Effect.gen(function* () {
          while (true) {
            const line = yield* Queue.take(output);
            const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(line);
            const message = yield* Schema.decodeUnknownEffect(Message)(parsed);
            if (message.id === id) return parsed;
          }
        });
      yield* send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      });
      yield* reply(1);
      yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
      yield* send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listed = yield* reply(2).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolList)));
      assert.sameMembers(
        listed.result.tools.map(({ name }) => name),
        httpTools,
      );
    }).pipe(Effect.timeout("20 seconds"), Effect.scoped),
  );
});
