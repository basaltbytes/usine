import { webRequest } from "../../../tooling/test/http.mts";
// The Node server adapter requires native HTTP server and connection types.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer, request, type RequestListener } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Tracer,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AttachRequest, GatewayAdminApi } from "../src/admin/api.ts";
import { AnonymousCredential } from "../src/attachment/attachment.ts";
import { CallerTokens } from "../src/caller/caller.ts";
import { serveEgressProxy } from "../src/node/egress-proxy.ts";
import { GatewayAddresses, gatewayLayer, type Listener } from "../src/node/node.ts";
import { UpstreamBase } from "../src/upstream.ts";
import { ADMIN_TOKEN_VALUE, NO_PROVIDERS, REPOSITORY, WORKER, settingsLayer } from "./fixtures.ts";
import { abandonedTunnel, rawThroughTunnel, silentTunnel, tlsThroughTunnel } from "./tunnel.ts";

// Pure serializers and synchronous callbacks return JSON values directly.
// @effect-diagnostics-next-line schemaSync:off
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const LOOPBACK = { host: "127.0.0.1", port: 0 };

const gateway = gatewayLayer({ proxy: LOOPBACK, egress: LOOPBACK, admin: LOOPBACK }).pipe(
  Layer.provide(settingsLayer(NO_PROVIDERS)),
  Layer.provideMerge(FetchHttpClient.layer),
);

/** The Gateway's log lines with their levels, for tests that provide `gatewayRecordingLogs`. */
const gatewayLines: Array<string> = [];

const gatewayRecordingLogs = gateway.pipe(
  Layer.provide(
    Logger.layer(
      [
        Logger.make(({ logLevel, message }) => {
          gatewayLines.push(stringifyJson({ level: logLevel, message }));
        }),
      ],
      { mergeWithExisting: true },
    ),
  ),
);

/** Returns the first line in `lines` containing `needle`, waiting briefly because the proxy logs after closing a connection. */
const logged = (lines: ReadonlyArray<string>, needle: string) =>
  Effect.suspend(() => {
    const line = lines.find((candidate) => candidate.includes(needle));
    return line === undefined
      ? Effect.fail(LogLineMissing.make({ message: `no log line contains ${needle}` }))
      : Effect.succeed(line);
  }).pipe(Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }));

/** Returns the refusal logged with `reason`. */
const refusalLogged = (reason: string) => logged(gatewayLines, `"reason":"${reason}"`);

/** The services the forward proxy needs without the reverse proxy and admin API. */
const egressServices = CallerTokens.layer.pipe(Layer.provideMerge(settingsLayer(NO_PROVIDERS)));

/**
 * Starts a local upstream that responds with `handler`, and a forward proxy whose Gateway
 * destination is that upstream, so `http://git.gw.test/...` relays to it. `messages` collects
 * the proxy's log lines.
 */
const relayToUpstream = (handler: RequestListener) =>
  Effect.gen(function* () {
    const messages: Array<string> = [];
    const logs = Logger.layer([
      Logger.make(({ message }) => {
        messages.push(stringifyJson(message));
      }),
    ]);
    const upstream = createServer(handler);
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        upstream.listen(0, "127.0.0.1", () => resume(Effect.void));
      }),
      () =>
        Effect.sync(() => {
          upstream.closeAllConnections();
          upstream.close();
        }),
    );
    const address = upstream.address();
    assert(address !== null && !Predicate.isString(address));
    const proxy = yield* serveEgressProxy(LOOPBACK, { host: "127.0.0.1", port: address.port }).pipe(
      Effect.provide(logs),
    );
    return { proxy, messages };
  });

/** A body chunk an upstream sends repeatedly until its connection is destroyed. */
const CHUNK = Buffer.alloc(64 * 1024);

const admin = (token: string) =>
  Effect.gen(function* () {
    const { admin } = yield* GatewayAddresses;
    return yield* HttpApiClient.make(GatewayAdminApi, {
      baseUrl: `http://${admin.host}:${admin.port}`,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    });
  });

/** Sends `CONNECT authority` to the forward proxy and returns the status and refusal reason. */
const connect = (proxy: Listener, authority: string) =>
  Effect.callback<{ status: number; reason: string | undefined }>((resume) => {
    const outgoing = request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
    });
    outgoing.once("connect", (response, socket) => {
      socket.destroy();
      const reason = response.headers["x-usine-gateway-refusal"];
      resume(Effect.succeed({ status: response.statusCode ?? 0, reason: reason?.toString() }));
    });
    outgoing.once("error", (error) => resume(Effect.die(error)));
    outgoing.end();
  });

/** Sends an absolute-form `GET url` to the forward proxy, like `HTTP_PROXY` clients, and returns the status and refusal reason. */
const relayed = (proxy: Listener, url: string) =>
  Effect.callback<{ status: number; reason: string | undefined }>((resume) => {
    const outgoing = request(
      { host: proxy.host, port: proxy.port, method: "GET", path: url },
      (response) => {
        response.resume();
        const reason = response.headers["x-usine-gateway-refusal"];
        resume(Effect.succeed({ status: response.statusCode ?? 0, reason: reason?.toString() }));
      },
    );
    outgoing.once("error", (error) => resume(Effect.die(error)));
    outgoing.end();
  });

const attachment = (minutes: number) =>
  Effect.map(DateTime.now, (now) =>
    AttachRequest.make({
      worker: WORKER,
      repository: REPOSITORY,
      credential: AnonymousCredential.make(),
      expiresAt: DateTime.add(now, { minutes }),
    }),
  );

describe("the Node gateway", () => {
  it.live("keeps caller credentials out of incoming proxy and admin traces", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    return Effect.gen(function* () {
      const { proxy, admin } = yield* GatewayAddresses;
      for (const listener of [proxy, admin]) {
        {
          const response = yield* webRequest(`http://${listener.host}:${listener.port}/`, {
            headers: {
              host: "git.gw.test",
              "x-usine-gateway-token": "synthetic-caller-secret",
              authorization: "Bearer synthetic-authorization-secret",
              "x-api-key": "synthetic-api-secret",
              cookie: "synthetic-cookie-secret",
            },
          });
          yield* Effect.promise(() => response.text());
        }
      }
      assert.isTrue(spans.some((span) => span.name === "GatewayProxy.handle"));
      for (const span of spans)
        assert.isFalse(
          [...span.attributes.keys()].some((name) => name.startsWith("http.request.header.")),
        );
      const json1 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        spans.map((span) => [...span.attributes]),
      ).pipe(Effect.orDie);
      assert.notInclude(json1, "synthetic-");
    }).pipe(Effect.provide(gateway), Effect.provideService(Tracer.Tracer, tracer));
  });

  it.live("fails a truncated chunked reverse-proxy response and logs safe failure fields", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const messages: Array<string> = [];
      const logs = Logger.layer([
        Logger.make(({ message }) => {
          const line = stringifyJson(message);
          messages.push(line);
          if (line.includes('"error":"UpstreamBodyFailure"'))
            Deferred.doneUnsafe(failed, Effect.void);
        }),
      ]);
      const upstream = createServer((_request, response) => {
        response.writeHead(200);
        // Waits until the Worker has received the first chunk before truncating.
        response.write("partial");
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          upstream.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () =>
          Effect.sync(() => {
            upstream.closeAllConnections();
            upstream.close();
          }),
      );
      const address = upstream.address();
      assert(address !== null && !Predicate.isString(address));
      const origin = UpstreamBase.make(`http://127.0.0.1:${address.port}`);
      const localGateway = gatewayLayer({
        proxy: LOOPBACK,
        egress: LOOPBACK,
        admin: LOOPBACK,
      }).pipe(
        Layer.provide(
          settingsLayer(NO_PROVIDERS, undefined, { web: origin, api: origin, uploads: origin }),
        ),
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(logs),
      );
      yield* Effect.gen(function* () {
        const client = yield* admin(ADMIN_TOKEN_VALUE);
        const attached = yield* client.attachments.attach({ payload: yield* attachment(60) });
        const token = Redacted.value(attached.callerToken);
        const { proxy } = yield* GatewayAddresses;
        const completed = yield* Effect.callback<boolean>((resume) => {
          const outgoing = request(
            {
              host: proxy.host,
              port: proxy.port,
              path: "/api/v3/repos/acme/demo",
              headers: { host: "git.gw.test", "x-usine-gateway-token": token },
            },
            (response) => {
              assert.strictEqual(response.statusCode, 200);
              response.on("data", () => upstream.closeAllConnections());
              response.on("error", () => {});
              response.once("close", () => resume(Effect.succeed(response.complete)));
            },
          );
          outgoing.once("error", (error) => resume(Effect.die(error)));
          outgoing.end();
          return Effect.sync(() => outgoing.destroy());
        }).pipe(Effect.timeout("2 seconds"));
        assert.isFalse(completed);
        yield* Deferred.await(failed).pipe(Effect.timeout("2 seconds"));
        assert.notInclude(messages.join("\n"), token);
        assert.include(messages.join("\n"), '"host":"git.gw.test"');
      }).pipe(Effect.provide(localGateway));
    }).pipe(Effect.scoped),
  );

  it.live(
    "the executor attaches, renews with the same token, lists without tokens, and detaches",
    () =>
      Effect.gen(function* () {
        const client = yield* admin(ADMIN_TOKEN_VALUE);
        const attached = yield* client.attachments.attach({ payload: yield* attachment(60) });
        assert.match(Redacted.value(attached.callerToken), /^ugw1\./u);
        const { id } = attached.attachment;
        const renewed = yield* client.attachments.renew({
          params: { id },
          payload: yield* attachment(120),
        });
        assert.strictEqual(
          Redacted.value(renewed.callerToken),
          Redacted.value(attached.callerToken),
        );
        const listed = yield* client.attachments.list();
        assert.deepStrictEqual(
          listed.attachments.map(({ worker, repository, credential }) => ({
            worker,
            repository,
            credential,
          })),
          [{ worker: WORKER, repository: REPOSITORY, credential: "AnonymousCredential" }],
        );
        assert.isTrue((yield* client.attachments.detach({ params: { id } })).detached);
        assert.deepStrictEqual((yield* client.attachments.list()).attachments, []);
        const fresh = yield* client.attachments.attach({ payload: yield* attachment(60) });
        assert.notStrictEqual(fresh.attachment.id, id);
        assert.notStrictEqual(
          Redacted.value(fresh.callerToken),
          Redacted.value(attached.callerToken),
        );
      }).pipe(Effect.provide(gateway)),
  );

  it.live(
    "the admin API refuses a wrong admin token, an expired attachment, and an attach body with an unknown key",
    () =>
      Effect.gen(function* () {
        gatewayLines.length = 0;
        const intruder = yield* admin("not-the-admin-token-0123456789abcdef");
        const refused = yield* Effect.flip(intruder.attachments.list());
        assert.strictEqual(refused._tag, "Unauthorized");
        const refusalMessages = yield* refusalLogged("bad-admin-token");
        assert.include(refusalMessages, '"endpoint":"list"');
        const client = yield* admin(ADMIN_TOKEN_VALUE);
        const expired = yield* Effect.flip(
          client.attachments.attach({ payload: yield* attachment(-1) }),
        );
        assert.strictEqual(expired._tag, "AttachmentAlreadyExpired");
        const { admin: address } = yield* GatewayAddresses;
        const attached = yield* attachment(5);
        const body = yield* Schema.encodeEffect(AttachRequest)(attached);
        const attach = (json: string) =>
          HttpClient.execute(
            HttpClientRequest.post(`http://${address.host}:${address.port}/v1/attachments`).pipe(
              HttpClientRequest.bearerToken(ADMIN_TOKEN_VALUE),
              HttpClientRequest.bodyText(json, "application/json"),
            ),
          );
        const json2 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(
          Effect.orDie,
        );
        assert.strictEqual((yield* attach(json2)).status, 200);
        const json3 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          ...body,
          typo: true,
        }).pipe(Effect.orDie);
        assert.strictEqual((yield* attach(json3)).status, 400);
      }).pipe(Effect.provide(gatewayRecordingLogs)),
  );

  it.live(
    "the forward proxy refuses unlisted hosts, IP addresses, and tunnels to a port other than 443",
    () =>
      Effect.gen(function* () {
        const { egress } = yield* GatewayAddresses;
        const connectionResponse = yield* connect(egress, "example.com:443");
        assert.deepStrictEqual(connectionResponse, {
          status: 403,
          reason: "host-not-allowed",
        });
        const currentConnectionResponse = yield* connect(egress, "registry.npmjs.org:80");
        assert.deepStrictEqual(currentConnectionResponse, {
          status: 403,
          reason: "port-not-allowed",
        });
        const nextConnectionResponse = yield* connect(egress, "127.0.0.1:443");
        assert.deepStrictEqual(nextConnectionResponse, {
          status: 403,
          reason: "address-literal",
        });
        const relayedResponse = yield* relayed(egress, "http://example.com/");
        assert.deepStrictEqual(relayedResponse, {
          status: 403,
          reason: "host-not-allowed",
        });
      }).pipe(Effect.provide(gateway)),
  );

  it.live("a tunnel carries only a TLS connection that asks for the CONNECT host itself", () =>
    Effect.gen(function* () {
      gatewayLines.length = 0;
      const { egress } = yield* GatewayAddresses;
      // An allowed CONNECT host, then a ClientHello for another tenant of its CDN address.
      const tunnelResponse = yield* tlsThroughTunnel(
        egress,
        "registry.npmjs.org:443",
        Option.some("example.com"),
      );
      assert.strictEqual(tunnelResponse, "refused");
      const mismatch = yield* refusalLogged("server-name-mismatch");
      assert.include(mismatch, '"host":"registry.npmjs.org"');
      assert.include(mismatch, '"serverName":"example.com"');
      const currentTunnelResponse = yield* tlsThroughTunnel(
        egress,
        "registry.npmjs.org:443",
        Option.none(),
      );
      assert.strictEqual(currentTunnelResponse, "refused");
      yield* refusalLogged("server-name-missing");
      const nextTunnelResponse = yield* rawThroughTunnel(
        egress,
        "registry.npmjs.org:443",
        "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n",
      );
      assert.strictEqual(nextTunnelResponse, "closed");
      yield* refusalLogged("not-tls");
      // A listed name that resolves to loopback is refused once its ClientHello has been checked.
      const updatedTunnelResponse = yield* tlsThroughTunnel(
        egress,
        "localhost:443",
        Option.some("localhost"),
      );
      assert.strictEqual(updatedTunnelResponse, "refused");
      yield* refusalLogged("private-address");
    }).pipe(Effect.provide(gatewayRecordingLogs)),
  );

  it.live("logs a tunnel the client closes before sending anything as abandoned, not refused", () =>
    Effect.gen(function* () {
      gatewayLines.length = 0;
      const { egress } = yield* GatewayAddresses;
      const tunnelResponse = yield* abandonedTunnel(egress, "registry.npmjs.org:443");
      assert.strictEqual(tunnelResponse, "closed");
      const abandoned = yield* logged(gatewayLines, "The client abandoned a tunnel");
      assert.include(abandoned, '"level":"Info"');
      assert.include(abandoned, '"host":"registry.npmjs.org"');
      assert.isFalse(gatewayLines.some((line) => line.includes("Gateway refused")));
    }).pipe(Effect.provide(gatewayRecordingLogs)),
  );

  it.live("closes while a tunnel waits for its ClientHello", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const proxy = yield* serveEgressProxy(LOOPBACK, LOOPBACK).pipe(Scope.provide(scope));
      yield* Effect.acquireRelease(silentTunnel(proxy, "registry.npmjs.org:443"), (socket) =>
        Effect.sync(() => socket.destroy()),
      );
      const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.timeoutOption("1 second"));
      assert.isTrue(Option.isSome(closed), "the proxy did not close within a second");
    }).pipe(Effect.scoped, Effect.provide(egressServices)),
  );

  it.live("closes the downstream and logs a failure when an upstream body is truncated", () =>
    Effect.gen(function* () {
      const { proxy, messages } = yield* relayToUpstream((_request, response) => {
        response.writeHead(200, { "content-length": "100" });
        response.write("partial", () => response.destroy());
      });
      const completed = yield* Effect.callback<boolean>((resume) => {
        const outgoing = request(
          { host: proxy.host, port: proxy.port, path: "http://git.gw.test/partial" },
          (response) => {
            // A truncated response emits an error before close; the incomplete body is asserted below.
            response.on("error", () => {});
            response.once("close", () => resume(Effect.succeed(response.complete)));
            response.resume();
          },
        );
        outgoing.once("error", (error) => resume(Effect.die(error)));
        outgoing.end();
        return Effect.sync(() => outgoing.destroy());
      }).pipe(Effect.timeout("1 second"));
      assert.isFalse(completed);
      yield* logged(messages, '"error":"Unreachable"');
    }).pipe(Effect.scoped, Effect.provide(egressServices)),
  );

  it.live("destroys the upstream connection and logs when the client abandons a download", () =>
    Effect.gen(function* () {
      const upstreamClosed = yield* Deferred.make<void>();
      const { proxy, messages } = yield* relayToUpstream((_request, response) => {
        response.writeHead(200);
        response.once("close", () => Deferred.doneUnsafe(upstreamClosed, Effect.void));
        // Only destroying the connection ends this body; a paused relay stalls on backpressure instead.
        const fill = (): void => {
          if (response.write(CHUNK)) setImmediate(fill);
          else response.once("drain", fill);
        };
        fill();
      });
      // The Worker reads the first bytes, then drops its connection.
      yield* Effect.callback<void>((resume) => {
        const outgoing = request(
          { host: proxy.host, port: proxy.port, path: "http://git.gw.test/download" },
          (response) => {
            response.on("error", () => {});
            response.once("data", () => {
              outgoing.destroy();
              resume(Effect.void);
            });
          },
        );
        outgoing.once("error", (error) => resume(Effect.die(error)));
        outgoing.end();
      });
      yield* Deferred.await(upstreamClosed).pipe(Effect.timeout("2 seconds"));
      const loggedMessages = yield* logged(messages, "The client abandoned a relayed request");
      assert.include(loggedMessages, '"status":200');
    }).pipe(Effect.scoped, Effect.provide(egressServices)),
  );

  it.live("destroys the upstream request and logs when the client abandons an upload", () =>
    Effect.gen(function* () {
      const arrived = yield* Deferred.make<void>();
      const upstreamComplete = yield* Deferred.make<boolean>();
      const { proxy, messages } = yield* relayToUpstream((request) => {
        request.once("close", () =>
          Deferred.doneUnsafe(upstreamComplete, Effect.succeed(request.complete)),
        );
        request.resume();
        Deferred.doneUnsafe(arrived, Effect.void);
      });
      // The Worker declares 1,000 bytes, sends a few, and drops its connection once the upstream has the request.
      const outgoing = yield* Effect.sync(() => {
        const outgoing = request({
          host: proxy.host,
          port: proxy.port,
          method: "POST",
          path: "http://git.gw.test/upload",
          headers: { "content-length": "1000" },
        });
        outgoing.on("error", () => {});
        outgoing.write("partial");
        return outgoing;
      });
      yield* Deferred.await(arrived).pipe(Effect.timeout("2 seconds"));
      yield* Effect.sync(() => outgoing.destroy());
      const upstreamCompleteResult = yield* Deferred.await(upstreamComplete).pipe(
        Effect.timeout("2 seconds"),
      );
      assert.isFalse(upstreamCompleteResult);
      const loggedMessages = yield* logged(messages, "The client abandoned a relayed request");
      assert.include(loggedMessages, '"status":"none"');
    }).pipe(Effect.scoped, Effect.provide(egressServices)),
  );

  it.live.each(["127.0.0.1", "::"])(
    "forwards requests to the gateway's own hosts when the reverse proxy binds to %s",
    (host) =>
      Effect.gen(function* () {
        const { egress } = yield* GatewayAddresses;
        const connectionResponse = yield* connect(egress, "llm.gw.test:80");
        assert.deepStrictEqual(connectionResponse, {
          status: 200,
          reason: undefined,
        });
        // The reverse proxy responded, which shows the request arrived; it has no caller token.
        const relayedResponse = yield* relayed(
          egress,
          "http://git.gw.test/acme/demo.git/info/refs",
        );
        assert.deepStrictEqual(relayedResponse, {
          status: 401,
          reason: "missing-caller-token",
        });
      }).pipe(
        Effect.provide(
          gatewayLayer({ proxy: { host, port: 0 }, egress: LOOPBACK, admin: LOOPBACK }).pipe(
            Layer.provide(settingsLayer(NO_PROVIDERS)),
            Layer.provideMerge(FetchHttpClient.layer),
          ),
        ),
      ),
  );
});

class LogLineMissing extends Schema.TaggedError<
  LogLineMissing,
  { readonly Brand: unique symbol }
>()("LogLineMissing", {
  message: Schema.String,
}) {}
