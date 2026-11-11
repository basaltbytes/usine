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
import { OperatorApi, operatorPermissions, UpgradeView } from "@usine/orchestrator/operator/http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { webRequest } from "../../../../tooling/test/http.mts";
import {
  type Cause,
  Context,
  Effect,
  Fiber,
  FileSystem,
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
import { Port } from "../../src/cli.ts";
import { apiRoutes, serverLayer } from "../../src/http.ts";
import { startupListener } from "../../src/listener.ts";
import { MCP_PATH, mcpRoutes } from "../../src/mcp/http.ts";
import { stdioServer } from "../../src/mcp/stdio.ts";
import { MAX_RESULT_BYTES } from "../../src/mcp/tools.ts";
import { ServerUpgrades } from "../../src/upgrade/control.ts";
import { authFixture } from "../auth/fixture.ts";

const cli = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
// Tests that wait for a request timeout or start the built CLI.
const slowCall = { timeout: 30_000 };

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
const JsonRpcLine = Schema.fromJsonString(
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Schema.optionalKey(Schema.Finite) }),
);
const initializeParams = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1" },
};

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
      runId === "run-slow"
        ? Effect.never
        : Effect.map(ActingMember, (actor) => {
            approvals.push({ runId, actor });
          }),
  });
  // `serverVersion` returns `running`, so a long one gives a tool result over the cap.
  const upgrades = Layer.mock(ServerUpgrades)({
    status: Effect.succeed(
      UpgradeView.make({
        running: "x".repeat(MAX_RESULT_BYTES * 2),
        channel: "next",
        mode: "propose",
        supported: true,
        available: null,
        phase: "idle",
        message: null,
        outcome: null,
      }),
    ),
  });
  const authenticated = authenticatedRoutes(services);
  const routes = Layer.mergeAll(
    apiRoutes.pipe(Layer.provide(authenticated.guard.layer)),
    mcpRoutes([]).pipe(
      Layer.provide(authenticated.guard.layer),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    authenticated.routes,
  ).pipe(HttpRouter.provideRequest(Layer.merge(backend, upgrades)));
  const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
  return { app, routes, device, approvals, services, backend, upgrades };
});

/** Serves `routes` on a loopback port and returns its origin. */
const serveOnLoopback = <E, R>(routes: Layer.Layer<never, E, R>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(NodeHttpServer.layerTest);
    const origin = yield* loopbackOrigin(context);
    yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true }).pipe(
        Layer.provide(Layer.succeedContext(context)),
      ),
    );
    return origin;
  });
const loopbackOrigin = (context: Context.Context<HttpServer.HttpServer>) => {
  const { address } = Context.get(context, HttpServer.HttpServer);
  return address._tag === "UnixPathAddress"
    ? Effect.die("The test server listens on a Unix socket.")
    : Effect.succeed(`http://127.0.0.1:${address.port}`);
};

/** An in-memory standard input and output for `stdioServer`, with a reader of JSON-RPC replies. */
const memoryStdio = Effect.gen(function* () {
  const input = yield* Queue.unbounded<Uint8Array>();
  const output = yield* Queue.unbounded<string>();
  const encoder = new TextEncoder();
  const send = (message: JsonObject) => Queue.offer(input, encoder.encode(`${jsonKey(message)}\n`));
  let buffered = "";
  const layer = Stdio.layerTest({
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
  const reply = (id: number) =>
    Effect.gen(function* () {
      while (true) {
        const line = yield* Queue.take(output);
        const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(line);
        const message = yield* Schema.decodeUnknownEffect(Message)(parsed);
        if (message.id === id) return parsed;
      }
    });
  return { layer, send, reply };
});

/**
 * Runs the built `usine mcp --origin` with `USINE_TOKEN`, writes `messages` to its standard input,
 * and closes the input after the reply to `lastId`. Returns the standard output up to that reply.
 */
const runMcpCommand = Effect.fn("test.runMcpCommand")(function* (
  origin: string,
  token: string,
  messages: ReadonlyArray<JsonObject>,
  lastId: number,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const encoder = new TextEncoder();
  for (const message of messages)
    yield* Queue.offer(input, encoder.encode(`${jsonKey(message)}\n`));
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [cli, "mcp", "--origin", origin], {
      cwd: tmpdir(),
      env: { USINE_TOKEN: token },
      extendEnv: true,
      stdin: Stream.fromQueue(input),
    }),
  );
  const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped);
  const stdout = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.takeUntil((line) => line.includes(`"id":${lastId}`)),
    Stream.runCollect,
  );
  yield* Queue.end(input);
  yield* child.exitCode;
  return { stdout, stderr: yield* Fiber.join(stderr) };
});

const inProcess =
  (app: { readonly handler: (request: Request) => Promise<Response> }) => (request: Request) =>
    Effect.promise(() => app.handler(request));

/** A JSON-RPC client of `POST /api/mcp` that keeps the session the server assigns. */
const mcpClient = <E, R>(
  send: (request: Request) => Effect.Effect<Response, E, R>,
  token: string,
  origin = "https://usine.example",
) => {
  let session: string | undefined;
  let id = 0;
  const post = (body: JsonObject) =>
    Effect.suspend(() => {
      const headers = new Headers({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      });
      if (session !== undefined) {
        headers.set("mcp-session-id", session);
        headers.set("mcp-protocol-version", "2025-06-18");
      }
      return send(
        new Request(`${origin}${MCP_PATH}`, {
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
  // Returns the response to `initialize`, whose body it has read.
  const initialize = post({
    jsonrpc: "2.0",
    id: ++id,
    method: "initialize",
    params: initializeParams,
  }).pipe(
    Effect.tap((response) => Effect.promise(() => response.json())),
    Effect.tap(() =>
      post({ jsonrpc: "2.0", method: "notifications/initialized" }).pipe(
        Effect.tap((response) => Effect.sync(() => assert.equal(response.status, 202))),
      ),
    ),
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
      const viewer = mcpClient(inProcess(app), viewerToken);
      yield* viewer.initialize;
      const viewerTools = yield* viewer.listTools;
      assert.sameMembers(viewerTools, expectedTools(["public", "read"]));
      const operatorToken = yield* device([grant("read"), grant("operate")]);
      const operator = mcpClient(inProcess(app), operatorToken);
      yield* operator.initialize;
      const operatorTools = yield* operator.listTools;
      assert.sameMembers(operatorTools, expectedTools(["public", "read", "operate"]));
      const ceilingToken = yield* device(
        administratorPermissions,
        Option.some([OperationId.make("operator.detail"), OperationId.make("operator.approve")]),
      );
      const ceiling = mcpClient(inProcess(app), ceilingToken);
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
      const client = mcpClient(inProcess(app), token);
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
      const ceilingToken = yield* device(
        administratorPermissions,
        Option.some([OperationId.make("operator.approve")]),
      );
      const ceiling = mcpClient(inProcess(app), ceilingToken);
      yield* ceiling.initialize;
      const ceilingTools = yield* ceiling.listTools;
      assert.deepEqual(ceilingTools, ["approve"]);
      const approved = yield* ceiling
        .call("approve", { runId: "run-2" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolCall)));
      assert.isNotTrue(approved.result.isError);
      assert.deepEqual(approvals[1], { runId: "run-2", actor: Option.some("alice") });
    }).pipe(Effect.scoped),
  );

  it.live("cuts a tool result over the cap and names the cut", () =>
    Effect.gen(function* () {
      const { app, device } = yield* fixture;
      const token = yield* device([grant("read")]);
      const client = mcpClient(inProcess(app), token);
      yield* client.initialize;
      const result = yield* client
        .call("serverVersion", {})
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolCall)));
      assert.isNotTrue(result.result.isError);
      const [kept, hint] = result.result.content;
      assert.equal(kept?.text, `"${"x".repeat(MAX_RESULT_BYTES - 1)}`);
      assert.include(hint?.text ?? "", `truncated this result at ${MAX_RESULT_BYTES} of`);
    }).pipe(Effect.scoped),
  );

  it.live("guards /api/mcp on the assembled server", () =>
    Effect.gen(function* () {
      const { device, approvals, services, backend, upgrades } = yield* fixture;
      const context = yield* Layer.build(NodeHttpServer.layerTest);
      const origin = yield* loopbackOrigin(context);
      const listener = yield* startupListener("test").pipe(Effect.provideContext(context));
      const fileSystem = yield* FileSystem.FileSystem;
      const webRoot = yield* fileSystem.makeTempDirectoryScoped();
      yield* Layer.build(
        serverLayer(
          backend,
          webRoot,
          Port.make(Number(new URL(origin).port)),
          services,
          upgrades,
          Layer.empty,
          undefined,
          listener,
        ),
      );
      const initialize = (headers: Readonly<Record<string, string>>) =>
        webRequest(`${origin}${MCP_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
          body: jsonKey({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams }),
        }).pipe(Effect.tap((response) => Effect.promise(() => response.arrayBuffer())));
      assert.equal((yield* initialize({})).status, 401);
      const token = yield* device([grant("read"), grant("operate")]);
      const authorization = { authorization: `Bearer ${token}` };
      assert.equal(
        (yield* initialize({ ...authorization, origin: "https://elsewhere.example" })).status,
        403,
      );
      const client = mcpClient((request) => webRequest(request), token, origin);
      const initialized = yield* client.initialize;
      assert.equal(initialized.status, 200);
      assert.equal(initialized.headers.get("x-frame-options"), "DENY");
      const result = yield* client
        .call("approve", { runId: "run-1" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolCall)));
      assert.isNotTrue(result.result.isError);
      assert.deepEqual(approvals, [{ runId: "run-1", actor: Option.some("alice") }]);
    }).pipe(Effect.provide([NodeServices.layer, FetchHttpClient.layer]), Effect.scoped),
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
      const client = mcpClient(inProcess(app), token);
      yield* client.initialize;
      const refused = yield* client
        .call("approve", { runId: "run-1" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RpcError)));
      assert.include(refused.error.message, "approve");
      const projectToken = yield* device([grant("read"), grant("operate")]);
      const project = mcpClient(inProcess(app), projectToken);
      yield* project.initialize;
      const otherProject = yield* project
        .call("pauseProjectLoop", { project: "beta", loop: "review" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolCall)));
      assert.isTrue(otherProject.result.isError);
      assert.include(otherProject.result.content[0]?.text ?? "", "HTTP 403");
      assert.deepEqual(approvals, []);
    }).pipe(Effect.scoped),
  );

  it.live(
    "lists the same tools over usine mcp --origin as over /api/mcp for one token",
    () =>
      Effect.gen(function* () {
        const { app, routes, device } = yield* fixture;
        const token = yield* device([grant("read"), grant("operate")]);
        const overHttp = mcpClient(inProcess(app), token);
        yield* overHttp.initialize;
        const httpTools = yield* overHttp.listTools;
        const origin = yield* serveOnLoopback(routes);
        const stdio = yield* memoryStdio;
        yield* Layer.build(
          stdioServer(origin, Redacted.make(token), "2 seconds").pipe(
            Layer.provide(stdio.layer),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        );
        yield* stdio.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: initializeParams,
        });
        yield* stdio.reply(1);
        yield* stdio.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        yield* stdio.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const listed = yield* stdio
          .reply(2)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolList)));
        assert.sameMembers(
          listed.result.tools.map(({ name }) => name),
          httpTools,
        );
        yield* stdio.send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "approve", arguments: { runId: "run-slow" } },
        });
        const slow = yield* stdio
          .reply(3)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolCall)));
        assert.isTrue(slow.result.isError);
        assert.include(slow.result.content[0]?.text ?? "", `Could not reach ${origin}`);
      }).pipe(Effect.timeout("20 seconds"), Effect.scoped),
    slowCall,
  );

  it.live("stops usine mcp --origin when the instance doesn't answer at start", () =>
    Effect.gen(function* () {
      const origin = yield* serveOnLoopback(
        HttpRouter.add("GET", "/api/openapi.json", Effect.never),
      );
      const stdio = yield* memoryStdio;
      const failure = yield* Layer.build(
        stdioServer(origin, Redacted.make("token"), "200 millis").pipe(
          Layer.provide(stdio.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        ),
      ).pipe(Effect.flip);
      assert.equal(failure._tag, "McpStartError");
      assert.include(failure.message, `Could not read ${origin}/api/openapi.json`);
    }).pipe(Effect.timeout("10 seconds"), Effect.scoped),
  );

  it.live(
    "serves a ceiling token's tools from the built usine mcp with only JSON-RPC on stdout",
    () =>
      Effect.gen(function* () {
        const { routes, device } = yield* fixture;
        const token = yield* device(
          administratorPermissions,
          Option.some([OperationId.make("operator.detail"), OperationId.make("operator.approve")]),
        );
        const origin = yield* serveOnLoopback(routes);
        const { stdout, stderr } = yield* runMcpCommand(
          origin,
          token,
          [
            { jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
          ],
          2,
        );
        assert.include(stderr, "MCP tools ready on standard input and output");
        const messages = yield* Effect.forEach(stdout, (line) =>
          Schema.decodeEffect(JsonRpcLine)(line).pipe(
            Effect.orElseSucceed(() =>
              assert.fail(`stdout holds a line that isn't JSON-RPC: ${line}`),
            ),
          ),
        );
        assert.deepEqual(
          messages.map(({ id }) => id),
          [1, 2],
        );
        const listed = yield* Schema.decodeEffect(Schema.fromJsonString(ToolList))(stdout[1] ?? "");
        assert.sameMembers(
          listed.result.tools.map(({ name }) => name),
          ["detail", "approve"],
        );
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(NodeServices.layer), Effect.scoped),
    slowCall,
  );
});
