import { createServer, request } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Layer, Logger, Predicate, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { AttachRequest, GatewayAdminApi } from "../src/admin/api.ts";
import { AnonymousCredential } from "../src/attachment/attachment.ts";
import { CallerTokens } from "../src/caller/caller.ts";
import { serveEgressProxy } from "../src/node/egress-proxy.ts";
import { GatewayAddresses, gatewayLayer, type Listener } from "../src/node/node.ts";
import { ADMIN_TOKEN_VALUE, NO_PROVIDERS, REPOSITORY, WORKER, settingsLayer } from "./fixtures.ts";

const LOOPBACK = { host: "127.0.0.1", port: 0 };

const gateway = gatewayLayer({ proxy: LOOPBACK, egress: LOOPBACK, admin: LOOPBACK }).pipe(
  Layer.provide(settingsLayer(NO_PROVIDERS)),
  Layer.provideMerge(FetchHttpClient.layer),
);

const admin = (token: string) =>
  Effect.gen(function* () {
    const { admin } = yield* GatewayAddresses;
    return yield* HttpApiClient.make(GatewayAdminApi, {
      baseUrl: `http://${admin.host}:${admin.port}`,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
    });
  });

/** Sends `CONNECT authority` to the forward proxy and resolves with the status and refusal reason. */
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

/** Sends an absolute-form `GET url` to the forward proxy, as `HTTP_PROXY` clients do, and resolves with the status and refusal reason. */
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
  Effect.map(
    DateTime.now,
    (now) =>
      new AttachRequest({
        worker: WORKER,
        repository: REPOSITORY,
        credential: new AnonymousCredential(),
        expiresAt: DateTime.add(now, { minutes }),
      }),
  );

describe("the Node gateway", () => {
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

  it.live("the admin API refuses a wrong admin token and an expired attachment", () =>
    Effect.gen(function* () {
      const intruder = yield* admin("not-the-admin-token-0123456789abcdef");
      const refused = yield* Effect.flip(intruder.attachments.list());
      assert.strictEqual(refused._tag, "Unauthorized");
      const client = yield* admin(ADMIN_TOKEN_VALUE);
      const expired = yield* Effect.flip(
        client.attachments.attach({ payload: yield* attachment(-1) }),
      );
      assert.strictEqual(expired._tag, "AttachmentAlreadyExpired");
    }).pipe(Effect.provide(gateway)),
  );

  it.live(
    "the forward proxy refuses unlisted hosts and listed names that resolve to private addresses",
    () =>
      Effect.gen(function* () {
        const { egress } = yield* GatewayAddresses;
        assert.deepStrictEqual(yield* connect(egress, "example.com:443"), {
          status: 403,
          reason: "host-not-allowed",
        });
        assert.deepStrictEqual(yield* connect(egress, "localhost:443"), {
          status: 403,
          reason: "private-address",
        });
        assert.deepStrictEqual(yield* connect(egress, "127.0.0.1:443"), {
          status: 403,
          reason: "address-literal",
        });
        assert.deepStrictEqual(yield* relayed(egress, "http://example.com/"), {
          status: 403,
          reason: "host-not-allowed",
        });
      }).pipe(Effect.provide(gateway)),
  );

  it.live("closes the downstream and logs a failure when an upstream body is truncated", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const logs = Logger.layer([
        Logger.make(({ message }) => {
          if (JSON.stringify(message).includes('"error":"Unreachable"'))
            Deferred.doneUnsafe(failed, Effect.void);
        }),
      ]);
      const upstream = createServer((_request, response) => {
        response.writeHead(200, { "content-length": "100" });
        response.write("partial", () => response.destroy());
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
      const proxy = yield* serveEgressProxy(LOOPBACK, {
        host: "127.0.0.1",
        port: address.port,
      }).pipe(Effect.provide(logs));
      const completed = yield* Effect.callback<boolean>((resume) => {
        const outgoing = request(
          { host: proxy.host, port: proxy.port, path: "http://git.gw.test/partial" },
          (response) => {
            // A truncated response emits an error before close; assert the incomplete body below.
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
      yield* Deferred.await(failed).pipe(Effect.timeout("1 second"));
    }).pipe(
      Effect.scoped,
      Effect.provide(CallerTokens.layer),
      Effect.provide(settingsLayer(NO_PROVIDERS)),
    ),
  );

  it.live(
    "a client that sends everything through the forward proxy still reaches the gateway's own hosts",
    () =>
      Effect.gen(function* () {
        const { egress } = yield* GatewayAddresses;
        assert.deepStrictEqual(yield* connect(egress, "llm.gw.test:80"), {
          status: 200,
          reason: undefined,
        });
        // The reverse proxy answers, so the request got there; it carries no caller token.
        assert.deepStrictEqual(
          yield* relayed(egress, "http://git.gw.test/acme/demo.git/info/refs"),
          {
            status: 401,
            reason: "missing-caller-token",
          },
        );
      }).pipe(Effect.provide(gateway)),
  );
});
