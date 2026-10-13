import { request } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { GatewayAdminApi } from "../src/admin/api.ts";
import { AnonymousCredential, Attachment } from "../src/attachment/attachment.ts";
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
      new Attachment({
        worker: WORKER,
        repository: REPOSITORY,
        credential: new AnonymousCredential(),
        expiresAt: DateTime.add(now, { minutes }),
      }),
  );

describe("the Node gateway", () => {
  it.live("the executor attaches, lists, and detaches; the list never contains a token", () =>
    Effect.gen(function* () {
      const client = yield* admin(ADMIN_TOKEN_VALUE);
      const attached = yield* client.attachments.attach({ payload: yield* attachment(60) });
      assert.match(Redacted.value(attached.callerToken), /^ugw1\./u);
      const listed = yield* client.attachments.list();
      assert.deepStrictEqual(
        listed.attachments.map(({ worker, repository, credential }) => ({
          worker,
          repository,
          credential,
        })),
        [{ worker: WORKER, repository: REPOSITORY, credential: "AnonymousCredential" }],
      );
      const detached = yield* client.attachments.detach({
        query: { worker: WORKER, repository: REPOSITORY },
      });
      assert.isTrue(detached.detached);
      assert.deepStrictEqual((yield* client.attachments.list()).attachments, []);
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
