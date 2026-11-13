import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { UsineConfig } from "@usine/config/factory";
import { LoadedInstance } from "@usine/config/instance";
import { assert, describe, it } from "@effect/vitest";
import {
  administratorPermissions,
  PermissionGrant,
  ProjectScope,
  type PermissionGrant as Grant,
} from "@usine/core/access";
import { jsonKey } from "@usine/core/json-key";
import { ActingMember, localActor } from "@usine/core/operator";
import { ProjectId } from "@usine/core/project";
import { type RunId } from "@usine/core/run";
import { OperatorApi, operatorPermissions, UpgradeView } from "@usine/orchestrator/operator/http";
import { WebhookHealth } from "@usine/orchestrator/webhooks";
// This synchronous Node crypto boundary signs the test's webhook delivery.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { webRequest } from "../../../../tooling/test/http.mts";
import {
  type Cause,
  Clock,
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Queue,
  Redacted,
  Result,
  Schema,
  Scope,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { OperationCeilingChange, OperationId, TokenName } from "../../src/auth/model.ts";
import type { AuthStore } from "../../src/auth/store.ts";
import { FactoryBackend } from "../../src/backend.ts";
import { Port } from "../../src/cli.ts";
import { apiRoutes, MAX_REQUEST_BODY_BYTES, serverLayer } from "../../src/http.ts";
import { operatorOpenApi } from "../../src/openapi.ts";
import { startupListener } from "../../src/listener.ts";
import { MCP_PATH, MCP_SESSION_IDLE, mcpRoutes } from "../../src/mcp/http.ts";
import {
  MAX_START_CONTAINERS,
  MAX_START_NESTING,
  MAX_START_RESPONSE_BYTES,
  stdioServer,
} from "../../src/mcp/stdio.ts";
import { MAX_RESULT_BYTES } from "../../src/mcp/tools.ts";
import { ServerUpgrades } from "../../src/upgrade/control.ts";
import { webhookEndpoint } from "../../src/webhooks.ts";
import {
  InstanceLaunch,
  InstanceRecord,
  instanceFiles,
  ProcessId,
  writeRecord,
} from "../../src/instance/record.ts";
import { authFixture, localSecret } from "../auth/fixture.ts";

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

interface LogLine {
  readonly message: unknown;
  readonly fields: unknown;
}

type Authenticate = ReturnType<AuthStore["Service"]["authenticate"]>;

/** How many sessions the server ended for going unused. */
const idleEnds = (logs: ReadonlyArray<LogLine>) =>
  logs.filter(
    ({ message, fields }) =>
      message === "MCP session ended" && jsonKey(fields ?? null) === jsonKey({ reason: "idle" }),
  ).length;

const makeFixture = () =>
  Effect.gen(function* () {
    // Replaces one call of the auth store's `authenticate`, after `skip` calls pass through.
    let interception:
      | { skip: number; readonly replace: (original: Authenticate) => Authenticate }
      | undefined;
    const wrapStore = (store: AuthStore["Service"]): AuthStore["Service"] => ({
      ...store,
      authenticate: (hash, now) =>
        Effect.suspend(() => {
          const current = interception;
          if (current === undefined || current.skip-- > 0) return store.authenticate(hash, now);
          interception = undefined;
          return current.replace(store.authenticate(hash, now));
        }),
    });
    // The server's clock runs ahead of real time by `skew` milliseconds.
    let skew = 0;
    const skewed = (real: Clock.Clock): Clock.Clock => ({
      ...real,
      currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe() + skew,
      currentTimeMillis: Effect.sync(() => real.currentTimeMillisUnsafe() + skew),
      currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe() + BigInt(skew) * 1_000_000n,
      currentTimeNanos: Effect.sync(
        () => real.currentTimeNanosUnsafe() + BigInt(skew) * 1_000_000n,
      ),
      sleep: (duration) => real.sleep(duration),
    });
    const logs: Array<LogLine> = [];
    const collector = Logger.make<unknown, void>(({ message }) => {
      const [text, fields] = Array.isArray(message) ? message : [message];
      logs.push({ message: text, fields });
    });
    const approvals: Array<{ readonly runId: RunId; readonly actor: Option.Option<string> }> = [];
    const services = yield* authFixture(undefined, undefined, undefined, wrapStore);
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
    const logged = HttpRouter.middleware(
      (handler) =>
        Effect.clockWith((real) =>
          handler.pipe(
            Effect.provide(Logger.layer([collector, Logger.defaultLogger])),
            Effect.provideService(Clock.Clock, skewed(real)),
          ),
        ),
      {
        global: true,
      },
    );
    const app = HttpRouter.toWebHandler(Layer.merge(routes, logged), { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
    return {
      app,
      routes,
      device,
      approvals,
      services,
      backend,
      upgrades,
      browser: { session, csrf: browser.csrf },
      logs,
      /** Moves the server's clock forward by `duration`. */
      advance: (duration: Duration.Input) =>
        Effect.sync(() => {
          skew += Duration.toMillis(Duration.fromInputUnsafe(duration));
        }),
      /** Replaces the auth store's `authenticate` result for one call, after `skip` calls. */
      intercept: (skip: number, replace: (original: Authenticate) => Authenticate) =>
        Effect.sync(() => {
          interception = { skip, replace };
        }),
    };
  });
const fixture = makeFixture();

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
 * Runs the built `usine mcp` with `args` in `cwd`, writes `messages` to its standard input, and
 * closes the input after the reply to `lastId`. Returns the standard output up to that reply.
 */
const runMcpCommand = Effect.fn("test.runMcpCommand")(function* (
  command: {
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  },
  messages: ReadonlyArray<JsonObject>,
  lastId: number,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const encoder = new TextEncoder();
  for (const message of messages)
    yield* Queue.offer(input, encoder.encode(`${jsonKey(message)}\n`));
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, [cli, "mcp", ...command.args], {
      cwd: command.cwd,
      env: command.env,
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

/**
 * A JSON-RPC client of `POST /api/mcp` that keeps the session the server assigns. A string
 * `credential` is a bearer token; an object holds the credential headers to send.
 */
const mcpClient = <E, R>(
  send: (request: Request) => Effect.Effect<Response, E, R>,
  credential: string | Readonly<Record<string, string>>,
  origin = "https://usine.example",
) => {
  let session: string | undefined;
  let id = 0;
  const credentialHeaders = Schema.is(Schema.String)(credential)
    ? { authorization: `Bearer ${credential}` }
    : credential;
  const post = (body: JsonObject) =>
    Effect.suspend(() => {
      const headers = new Headers({
        ...credentialHeaders,
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
  const rpc = (method: string, params: JsonObject = {}) =>
    post({ jsonrpc: "2.0", id: ++id, method, params });
  const request = (method: string, params: JsonObject = {}) =>
    rpc(method, params).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())));
  // Ends the session with DELETE and returns the status.
  const end = Effect.suspend(() =>
    send(
      new Request(`${origin}${MCP_PATH}`, {
        method: "DELETE",
        headers: {
          ...credentialHeaders,
          "mcp-session-id": session ?? "",
          "mcp-protocol-version": "2025-06-18",
        },
      }),
    ),
  ).pipe(Effect.map(({ status }) => status));
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
  return {
    initialize,
    listTools,
    call,
    end,
    status: (method: string) => rpc(method).pipe(Effect.map(({ status }) => status)),
    session: () => session,
    useSession: (other: string | undefined) => {
      session = other;
    },
  };
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

  it.live("serves a browser session that sends its CSRF header", () =>
    Effect.gen(function* () {
      const { app, approvals, browser } = yield* fixture;
      const cookie = { cookie: `usine_session=${browser.session}` };
      const withoutCsrf = yield* Effect.promise(() =>
        app.handler(
          new Request(`https://usine.example${MCP_PATH}`, {
            method: "POST",
            headers: {
              ...cookie,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: jsonKey({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: initializeParams,
            }),
          }),
        ),
      );
      assert.equal(withoutCsrf.status, 403);
      const client = mcpClient(inProcess(app), { ...cookie, "x-usine-csrf": browser.csrf });
      assert.equal((yield* client.initialize).status, 200);
      const result = yield* client
        .call("approve", { runId: "run-1" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolCall)));
      assert.isNotTrue(result.result.isError);
      assert.deepEqual(approvals, [{ runId: "run-1", actor: Option.some("alice") }]);
    }).pipe(Effect.scoped),
  );

  it.live("answers a session only for the credential that opened it", () =>
    Effect.gen(function* () {
      const { app, device } = yield* fixture;
      const ownerToken = yield* device([grant("read"), grant("operate")]);
      const owner = mcpClient(inProcess(app), ownerToken);
      yield* owner.initialize;
      // The same grants share one tool server, which knows the owner's session.
      const otherToken = yield* device([grant("read"), grant("operate")]);
      const other = mcpClient(inProcess(app), otherToken);
      other.useSession(owner.session());
      const borrowed = yield* other.status("tools/list");
      const borrowedEnd = yield* other.end;
      // Other grants give another tool list, which must not end the owner's session.
      const narrowToken = yield* device([grant("read")]);
      const narrow = mcpClient(inProcess(app), narrowToken);
      narrow.useSession(owner.session());
      const narrowed = yield* narrow.status("tools/list");
      const narrowedEnd = yield* narrow.end;
      const ownerTools = yield* owner.listTools;
      const ended = yield* owner.end;
      const afterEnd = yield* owner.status("tools/list");
      assert.deepEqual(
        [borrowed, borrowedEnd, narrowed, narrowedEnd, ended, afterEnd],
        [404, 404, 404, 404, 204, 404],
      );
      assert.sameMembers(ownerTools, expectedTools(["public", "read", "operate"]));
    }).pipe(Effect.scoped),
  );

  it.live("ends a session on its tool server after it goes unused for the idle time", () =>
    Effect.gen(function* () {
      const { app, device, logs, advance } = yield* fixture;
      const token = yield* device([grant("read")]);
      const client = mcpClient(inProcess(app), token);
      yield* client.initialize;
      // Each request restarts the idle time, so a session in use outlives it.
      const half = Duration.toMillis(MCP_SESSION_IDLE) / 2;
      yield* advance(half + 1);
      const midway = yield* client.status("tools/list");
      yield* advance(half + 1);
      const pastOpening = yield* client.status("tools/list");
      assert.deepEqual([midway, pastOpening], [200, 200]);
      yield* advance(MCP_SESSION_IDLE);
      const expired = yield* client.status("tools/list");
      assert.equal(expired, 404);
      assert.deepInclude(logs, { message: "MCP session ended", fields: { reason: "idle" } });
      // A new session starts on the same tool server.
      client.useSession(undefined);
      yield* client.initialize;
      const after = yield* client.listTools;
      assert.sameMembers(after, expectedTools(["public", "read"]));
    }).pipe(Effect.scoped),
  );

  it.live("ends idle sessions when a browser session's GET triggers the sweep", () =>
    Effect.gen(function* () {
      const { app, device, browser, logs, advance } = yield* fixture;
      const token = yield* device([grant("read")]);
      const client = mcpClient(inProcess(app), token);
      yield* client.initialize;
      yield* advance(MCP_SESSION_IDLE);
      // A browser opens the MCP URL: a GET with the session cookie and no CSRF header.
      const opened = yield* Effect.promise(() =>
        app.handler(
          new Request(`https://usine.example${MCP_PATH}`, {
            headers: { cookie: `usine_session=${browser.session}` },
          }),
        ),
      );
      assert.notEqual(opened.status, 403);
      assert.deepInclude(logs, { message: "MCP session ended", fields: { reason: "idle" } });
      assert.notInclude(
        logs.map(({ message }) => message),
        "MCP tool server did not end the session; the next sweep retries",
      );
      const owned = yield* client.status("tools/list");
      assert.equal(owned, 404);
    }).pipe(Effect.scoped),
  );

  it.live("hands the sessions of an aborted sweep to the next sweep", () =>
    Effect.gen(function* () {
      const { app, device, browser, logs, advance, intercept } = yield* fixture;
      const token = yield* device([grant("read")]);
      const owner = mcpClient(inProcess(app), token);
      yield* owner.initialize;
      for (const _ of [1, 2]) yield* mcpClient(inProcess(app), token).initialize;
      yield* advance(MCP_SESSION_IDLE);
      // The browser's GET authenticates once; the sweep's first DELETE then waits in the store.
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* intercept(1, (original) =>
        Deferred.succeed(held, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(original),
        ),
      );
      // Closing `connection` aborts the request, as a client that goes away does.
      const connection = yield* Scope.make();
      const signal = yield* Effect.abortSignal.pipe(Scope.provide(connection));
      const aborted = app.handler(
        new Request(`https://usine.example${MCP_PATH}`, {
          headers: { cookie: `usine_session=${browser.session}` },
          signal,
        }),
      );
      yield* Deferred.await(held);
      yield* Scope.close(connection, Exit.void);
      yield* Effect.promise(() => aborted);
      yield* Deferred.succeed(release, undefined);
      assert.equal(idleEnds(logs), 0);
      assert.deepInclude(logs, {
        message: "MCP sweep handed sessions back for the next sweep",
        fields: { sessions: 3, reasons: "idle" },
      });
      const owned = yield* owner.status("tools/list");
      assert.equal(owned, 404);
      assert.equal(idleEnds(logs), 3);
    }).pipe(Effect.scoped),
  );

  it.live("hands back only the sessions that an aborted sweep didn't end", () =>
    Effect.gen(function* () {
      const { app, device, browser, logs, advance, intercept } = yield* fixture;
      const token = yield* device([grant("read")]);
      const owner = mcpClient(inProcess(app), token);
      yield* owner.initialize;
      for (const _ of [1, 2]) yield* mcpClient(inProcess(app), token).initialize;
      yield* advance(MCP_SESSION_IDLE);
      // The browser's GET and the sweep's first DELETE authenticate; the second DELETE waits.
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* intercept(2, (original) =>
        Deferred.succeed(held, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(original),
        ),
      );
      const connection = yield* Scope.make();
      const signal = yield* Effect.abortSignal.pipe(Scope.provide(connection));
      const aborted = app.handler(
        new Request(`https://usine.example${MCP_PATH}`, {
          headers: { cookie: `usine_session=${browser.session}` },
          signal,
        }),
      );
      yield* Deferred.await(held);
      yield* Scope.close(connection, Exit.void);
      yield* Effect.promise(() => aborted);
      yield* Deferred.succeed(release, undefined);
      assert.equal(idleEnds(logs), 1);
      assert.deepInclude(logs, {
        message: "MCP sweep handed sessions back for the next sweep",
        fields: { sessions: 2, reasons: "idle" },
      });
      const owned = yield* owner.status("tools/list");
      assert.equal(owned, 404);
      assert.equal(idleEnds(logs), 3);
      assert.notInclude(
        logs.map(({ message }) => message),
        "MCP session already ended on its tool server",
      );
    }).pipe(Effect.scoped),
  );

  it.live("ends the other sessions of a sweep when one session's end fails", () =>
    Effect.gen(function* () {
      const { app, device, browser, logs, advance, intercept } = yield* fixture;
      const token = yield* device([grant("read")]);
      const owner = mcpClient(inProcess(app), token);
      yield* owner.initialize;
      yield* mcpClient(inProcess(app), token).initialize;
      yield* advance(MCP_SESSION_IDLE);
      // The browser's GET authenticates once; the auth store then dies on the sweep's first DELETE.
      yield* intercept(1, () => Effect.die("The auth store failed."));
      const opened = yield* Effect.promise(() =>
        app.handler(
          new Request(`https://usine.example${MCP_PATH}`, {
            headers: { cookie: `usine_session=${browser.session}` },
          }),
        ),
      );
      assert.equal(opened.status, 405);
      assert.include(
        logs.map(({ message }) => message),
        "MCP tool server did not end the session; the next sweep retries",
      );
      assert.equal(idleEnds(logs), 1);
      assert.deepInclude(logs, {
        message: "MCP sweep handed sessions back for the next sweep",
        fields: { sessions: 1, reasons: "idle" },
      });
      const owned = yield* owner.status("tools/list");
      assert.equal(owned, 404);
      assert.equal(idleEnds(logs), 2);
    }).pipe(Effect.scoped),
  );

  it.live("retries a session whose tool server refused the sweep's DELETE", () =>
    Effect.gen(function* () {
      const { app, device, browser, logs, advance, intercept } = yield* fixture;
      const token = yield* device([grant("read")]);
      const owner = mcpClient(inProcess(app), token);
      yield* owner.initialize;
      yield* advance(MCP_SESSION_IDLE);
      // The browser's GET authenticates once; the sweep's DELETE then finds no credential.
      yield* intercept(1, () => Effect.succeedNone);
      yield* Effect.promise(() =>
        app.handler(
          new Request(`https://usine.example${MCP_PATH}`, {
            headers: { cookie: `usine_session=${browser.session}` },
          }),
        ),
      );
      assert.deepInclude(logs, {
        message: "MCP tool server did not end the session; the next sweep retries",
        fields: { reason: "idle", status: 401 },
      });
      assert.equal(idleEnds(logs), 0);
      const owned = yield* owner.status("tools/list");
      assert.equal(owned, 404);
      assert.equal(idleEnds(logs), 1);
    }).pipe(Effect.scoped),
  );

  it.live("ends a session on its old tool server when the token's tool list changes", () =>
    Effect.gen(function* () {
      const { app, device, browser, services, logs } = yield* fixture;
      const token = yield* device([grant("read")]);
      const client = mcpClient(inProcess(app), token);
      yield* client.initialize;
      const before = yield* client.listTools;
      assert.sameMembers(before, expectedTools(["public", "read"]));
      const access = yield* services.authentication.authenticate(token);
      const tokenId = yield* Effect.fromOption(access.token, () => "The token has no record.");
      yield* services.authentication.setScopes(
        browser.session,
        tokenId.id,
        [grant("read"), grant("operate")],
        OperationCeilingChange.Keep(),
      );
      const changed = yield* client.status("tools/list");
      assert.equal(changed, 404);
      // Only a 204 from the old tool server logs this message.
      assert.deepInclude(logs, {
        message: "MCP session ended",
        fields: { reason: "tools-changed" },
      });
      client.useSession(undefined);
      yield* client.initialize;
      const after = yield* client.listTools;
      assert.sameMembers(after, expectedTools(["public", "read", "operate"]));
    }).pipe(Effect.scoped),
  );

  it.live("forgets a session that its client ended, so the idle sweep skips it", () =>
    Effect.gen(function* () {
      const { app, device, logs, advance } = yield* fixture;
      const token = yield* device([grant("read")]);
      const client = mcpClient(inProcess(app), token);
      yield* client.initialize;
      // The tool server refuses a DELETE with an unsupported protocol version and keeps the session.
      const refused = yield* Effect.promise(() =>
        app.handler(
          new Request(`https://usine.example${MCP_PATH}`, {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${token}`,
              "mcp-session-id": client.session() ?? "",
              "mcp-protocol-version": "1999-01-01",
            },
          }),
        ),
      );
      assert.equal(refused.status, 400);
      const kept = yield* client.status("tools/list");
      assert.equal(kept, 200);
      assert.notDeepInclude(logs, { message: "MCP session ended", fields: { reason: "client" } });
      assert.deepInclude(logs, {
        message: "MCP tool server refused the client's DELETE; the session stays open",
        fields: { status: 400 },
      });
      const ended = yield* client.end;
      assert.equal(ended, 204);
      yield* advance(MCP_SESSION_IDLE);
      client.useSession(undefined);
      yield* client.initialize;
      assert.deepInclude(logs, { message: "MCP session ended", fields: { reason: "client" } });
      assert.deepEqual(
        logs.filter(({ fields }) => jsonKey(fields ?? null) === jsonKey({ reason: "idle" })),
        [],
      );
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

  it.live("guards /api/mcp and limits request bodies on the assembled server", () =>
    Effect.gen(function* () {
      const { device, approvals, services, backend, upgrades, browser } = yield* fixture;
      const context = yield* Layer.build(NodeHttpServer.layerTest);
      const origin = yield* loopbackOrigin(context);
      const listener = yield* startupListener("test").pipe(Effect.provideContext(context));
      const fileSystem = yield* FileSystem.FileSystem;
      const webRoot = yield* fileSystem.makeTempDirectoryScoped();
      const webhookSecret = "webhook-test-secret";
      const loaded = LoadedInstance.make({
        config: yield* Schema.decodeEffect(UsineConfig)({
          version: 1,
          repos: [],
          webhooks: { mode: "endpoint", public_url: "https://usine.example/webhooks/github" },
        }),
        agents: [],
        loops: [],
        invalidAgents: [],
        quarantinedLoops: [],
        warnings: [],
      });
      const webhooks = yield* webhookEndpoint(
        { get: Effect.succeed(loaded), changes: Stream.never },
        { hint: () => Effect.void },
        WebhookHealth.of({
          startedAt: yield* DateTime.now,
          reset: Effect.void,
          received: Effect.void,
          silent: Effect.succeed(false),
        }),
        { configureWebhook: () => Effect.void },
      ).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ USINE_GITHUB_WEBHOOK_SECRET: webhookSecret }),
        ),
      );
      yield* Layer.build(serverLayer(backend, webRoot, listener, services, upgrades, webhooks));
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
      // One limit covers every route: an MCP request and an operator API request.
      const initializeWith = (padding: number) =>
        webRequest(`${origin}${MCP_PATH}`, {
          method: "POST",
          headers: {
            ...authorization,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: jsonKey({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { ...initializeParams, padding: "x".repeat(padding) },
          }),
        }).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())));
      const underLimit = yield* initializeWith(MAX_REQUEST_BODY_BYTES - 1024);
      assert.property(underLimit, "result");
      const tooLarge = yield* initializeWith(MAX_REQUEST_BODY_BYTES).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RpcError)),
      );
      assert.equal(tooLarge.error.message, "Parse error");
      const dismissed = yield* webRequest(`${origin}/api/attention/dismiss`, {
        method: "POST",
        headers: {
          cookie: `usine_session=${browser.session}`,
          "x-usine-csrf": browser.csrf,
          "content-type": "application/json",
        },
        body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
      }).pipe(Effect.tap((response) => Effect.promise(() => response.arrayBuffer())));
      assert.equal(dismissed.status, 413);
      // A GitHub webhook delivery keeps its own, larger limit.
      const delivery = jsonKey({ padding: "x".repeat(MAX_REQUEST_BODY_BYTES) });
      const delivered = yield* webRequest(`${origin}/webhooks/github`, {
        method: "POST",
        headers: {
          "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(delivery).digest("hex")}`,
          "x-github-event": "ping",
        },
        body: delivery,
      }).pipe(Effect.tap((response) => Effect.promise(() => response.arrayBuffer())));
      assert.equal(delivered.status, 204);
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

  it.live("sends the token of usine mcp --origin only to the origin", () =>
    Effect.gen(function* () {
      const elsewhere: Array<string> = [];
      const other = yield* serveOnLoopback(
        HttpRouter.add(
          "*",
          "*",
          Effect.sync(() => {
            elsewhere.push("request");
            return HttpServerResponse.empty();
          }),
        ),
      );
      const document = structuredClone(operatorOpenApi());
      const approvePath = "/api/runs/{runId}/approve";
      // A path key that starts with `//` names another host.
      document.paths = Object.fromEntries(
        Object.entries(document.paths).map(([path, item]) => [
          path === approvePath ? `//${new URL(other).host}${path}` : path,
          item,
        ]),
      );
      const origin = yield* serveOnLoopback(
        Layer.mergeAll(
          HttpRouter.add("GET", "/api/openapi.json", HttpServerResponse.jsonUnsafe(document)),
          HttpRouter.add(
            "GET",
            "/api/auth/session",
            HttpServerResponse.jsonUnsafe({
              permissions: [{ permission: "admin", scope: { _tag: "Instance" } }],
              operations: ["operator.approve"],
            }),
          ),
        ),
      );
      const stdio = yield* memoryStdio;
      yield* Layer.build(
        stdioServer(origin, Redacted.make("token"), "2 seconds").pipe(
          Layer.provide(stdio.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        ),
      );
      yield* stdio.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
      yield* stdio.reply(1);
      yield* stdio.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      yield* stdio.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "approve", arguments: { runId: "run-1" } },
      });
      const refused = yield* stdio
        .reply(2)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolCall)));
      assert.isTrue(refused.result.isError);
      assert.include(
        refused.result.content[0]?.text ?? "",
        `Refused to send the token to ${other}`,
      );
      assert.deepEqual(elsewhere, []);
    }).pipe(Effect.timeout("10 seconds"), Effect.scoped),
  );

  it.live("warns when usine mcp --origin runs out of inlining budget", () =>
    Effect.gen(function* () {
      // 1,000 references to a 2,000-entry `enum` would copy about 4 MB.
      const document = {
        paths: {
          "/api/large": {
            get: {
              operationId: "operator.large",
              parameters: Array.from({ length: 1_000 }, (_, index) => ({
                name: `p${index}`,
                in: "query",
                schema: { $ref: "#/components/schemas/Enum" },
              })),
              responses: { "200": {} },
              "x-usine-permission": "read",
            },
          },
        },
        components: {
          schemas: { Enum: { type: "integer", enum: Array.from({ length: 2_000 }, () => 0) } },
        },
      };
      const origin = yield* serveOnLoopback(
        Layer.mergeAll(
          HttpRouter.add("GET", "/api/openapi.json", HttpServerResponse.jsonUnsafe(document)),
          HttpRouter.add(
            "GET",
            "/api/auth/session",
            HttpServerResponse.jsonUnsafe({
              permissions: [{ permission: "admin", scope: { _tag: "Instance" } }],
            }),
          ),
        ),
      );
      const warnings: Array<string> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(jsonKey(message));
      });
      const stdio = yield* memoryStdio;
      yield* Layer.build(
        stdioServer(origin, Redacted.make("token"), "2 seconds").pipe(
          Layer.provide(stdio.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        ),
      ).pipe(Effect.provide(Logger.layer([logger])));
      assert.lengthOf(warnings, 1);
      assert.include(
        warnings[0],
        "MCP tool schemas accept any value in places: the inlining budget or depth ran out",
      );
      assert.include(warnings[0], origin);
    }).pipe(Effect.timeout("10 seconds"), Effect.scoped),
  );

  it.live("stops usine mcp --origin when a start response is over the size cap", () =>
    Effect.gen(function* () {
      const origin = yield* serveOnLoopback(
        HttpRouter.add(
          "GET",
          "/api/openapi.json",
          HttpServerResponse.text(`"${"x".repeat(MAX_START_RESPONSE_BYTES)}"`, {
            contentType: "application/json",
          }),
        ),
      );
      const stdio = yield* memoryStdio;
      const failure = yield* Layer.build(
        stdioServer(origin, Redacted.make("token"), "5 seconds").pipe(
          Layer.provide(stdio.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        ),
      ).pipe(Effect.flip);
      assert.equal(failure._tag, "McpStartError");
      assert.include(
        failure.message,
        `${origin}/api/openapi.json returned more than ${MAX_START_RESPONSE_BYTES} bytes`,
      );
    }).pipe(Effect.timeout("10 seconds"), Effect.scoped),
  );

  it.live("stops usine mcp --origin before decoding a start response nested too deeply", () =>
    Effect.gen(function* () {
      // The document nests 7 levels around `levels` arrays of an `enum`. The strings hold escaped
      // quotes, an escaped backslash, and brackets, which the scan must read as text.
      const document = (levels: number) =>
        `{"paths": {"/api/deep": {"get": {"operationId": "operator.deep", "parameters": [{"name": "value", "in": "query", "description": "say \\"hi\\" \\\\", "schema": {"enum": ${"[".repeat(levels)}"\\"[[[{{{"${"]".repeat(levels)}}}], "responses": {"200": {}}, "x-usine-permission": "read"}}}, "components": {"schemas": {}}}`;
      const start = (levels: number) =>
        Effect.gen(function* () {
          const origin = yield* serveOnLoopback(
            Layer.mergeAll(
              HttpRouter.add(
                "GET",
                "/api/openapi.json",
                HttpServerResponse.text(document(levels), { contentType: "application/json" }),
              ),
              HttpRouter.add(
                "GET",
                "/api/auth/session",
                HttpServerResponse.jsonUnsafe({
                  permissions: [{ permission: "admin", scope: { _tag: "Instance" } }],
                }),
              ),
            ),
          );
          const warnings: Array<string> = [];
          const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
            if (logLevel === "Warn") warnings.push(jsonKey(message));
          });
          const stdio = yield* memoryStdio;
          const result = yield* Layer.build(
            stdioServer(origin, Redacted.make("token"), "2 seconds").pipe(
              Layer.provide(stdio.layer),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(NodeServices.layer),
            ),
          ).pipe(Effect.provide(Logger.layer([logger])), Effect.result);
          return { origin, result, warnings };
        });
      const refused = yield* start(MAX_START_NESTING - 6);
      const failure = Result.getFailure(refused.result).pipe(Option.getOrThrow);
      assert.equal(failure._tag, "McpStartError");
      assert.include(
        failure.message,
        `${refused.origin}/api/openapi.json nests arrays and objects more than ${MAX_START_NESTING} levels deep`,
      );
      assert.lengthOf(refused.warnings, 1);
      assert.include(refused.warnings[0], "MCP start response refused: nested too deeply");
      // Exactly at the limit, the document decodes, and inlining cuts the schema at its own limit.
      const accepted = yield* start(MAX_START_NESTING - 7);
      assert.isTrue(Result.isSuccess(accepted.result));
      assert.lengthOf(accepted.warnings, 1);
      assert.include(accepted.warnings[0], "the inlining budget or depth ran out");
    }).pipe(Effect.timeout("10 seconds"), Effect.scoped),
  );

  it.live("stops usine mcp --origin before decoding a start response with too many values", () =>
    Effect.gen(function* () {
      const origin = yield* serveOnLoopback(
        HttpRouter.add(
          "GET",
          "/api/openapi.json",
          HttpServerResponse.text(`[${Array.from({ length: MAX_START_CONTAINERS }, () => "[]")}]`, {
            contentType: "application/json",
          }),
        ),
      );
      const stdio = yield* memoryStdio;
      const failure = yield* Layer.build(
        stdioServer(origin, Redacted.make("token"), "5 seconds").pipe(
          Layer.provide(stdio.layer),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
        ),
      ).pipe(Effect.flip);
      assert.equal(failure._tag, "McpStartError");
      assert.include(
        failure.message,
        `${origin}/api/openapi.json holds more than ${MAX_START_CONTAINERS} arrays and objects`,
      );
    }).pipe(Effect.timeout("10 seconds"), Effect.scoped),
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

  it.live("stops usine mcp --origin when the instance sends headers and then holds the body", () =>
    Effect.gen(function* () {
      const origin = yield* serveOnLoopback(
        HttpRouter.add(
          "GET",
          "/api/openapi.json",
          HttpServerResponse.stream(
            Stream.concat(Stream.make("{"), Stream.never).pipe(Stream.encodeText),
            {
              contentType: "application/json",
            },
          ),
        ),
      );
      const stdio = yield* memoryStdio;
      const failure = yield* Layer.build(
        stdioServer(origin, Redacted.make("token"), "500 millis").pipe(
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
          { args: ["--origin", origin], cwd: tmpdir(), env: { USINE_TOKEN: token } },
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

  it.live(
    "serves the instance of the current folder from the built usine mcp with the admin token",
    () =>
      Effect.gen(function* () {
        const { app, routes, approvals } = yield* fixture;
        const overHttp = mcpClient(inProcess(app), localSecret);
        yield* overHttp.initialize;
        const httpTools = yield* overHttp.listTools;
        const origin = yield* serveOnLoopback(routes);
        const fileSystem = yield* FileSystem.FileSystem;
        const folder = yield* fileSystem.makeTempDirectoryScoped();
        const files = instanceFiles(folder);
        yield* fileSystem.makeDirectory(files.folder);
        yield* fileSystem.writeFileString(`${files.folder}/admin-token`, localSecret, {
          mode: 0o600,
        });
        yield* writeRecord(
          files,
          InstanceRecord.make({
            pid: ProcessId.make(process.pid),
            version: "1.0.0",
            startedAt: DateTime.nowUnsafe(),
            launch: InstanceLaunch.make({
              node: process.execPath,
              nodeOptions: [],
              script: cli,
              port: Port.make(Number(new URL(origin).port)),
              logLevel: "Info",
              allowVolatileInstance: false,
            }),
          }),
        );
        const { stdout } = yield* runMcpCommand(
          { args: [], cwd: folder, env: {} },
          [
            { jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams },
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
            {
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "approve", arguments: { runId: "run-1" } },
            },
          ],
          3,
        );
        const messages = yield* Effect.forEach(stdout, (line) =>
          Schema.decodeEffect(JsonRpcLine)(line).pipe(
            Effect.orElseSucceed(() =>
              assert.fail(`stdout holds a line that isn't JSON-RPC: ${line}`),
            ),
          ),
        );
        // The server may send notifications, which have no ID, between the replies.
        const reply = (id: number) => stdout[messages.findIndex((message) => message.id === id)];
        assert.deepEqual(
          messages.flatMap(({ id }) => (id === undefined ? [] : [id])),
          [1, 2, 3],
        );
        const listed = yield* Schema.decodeEffect(Schema.fromJsonString(ToolList))(reply(2) ?? "");
        assert.sameMembers(
          listed.result.tools.map(({ name }) => name),
          httpTools,
        );
        const approved = yield* Schema.decodeEffect(Schema.fromJsonString(ToolCall))(
          reply(3) ?? "",
        );
        assert.isNotTrue(approved.result.isError);
        assert.deepEqual(approvals, [{ runId: "run-1", actor: Option.some<string>(localActor) }]);
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(NodeServices.layer), Effect.scoped),
    slowCall,
  );
});
