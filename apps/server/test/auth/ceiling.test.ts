import { assert, describe, it } from "@effect/vitest";
import { administratorPermissions, InstanceScope, PermissionGrant } from "@usine/core/access";
import { jsonKey } from "@usine/core/json-key";
import { ChangeBus, changeBusLayer } from "@usine/core/changes";
import { UpgradeView } from "@usine/orchestrator/operator/http";
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter } from "effect/http";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { OperationCeilingChange, OperationId, TokenName } from "../../src/auth/model.ts";
import { FactoryBackend } from "../../src/backend.ts";
import { apiRoutes } from "../../src/http.ts";
import { ProviderLogins } from "../../src/providers/control.ts";
import { providerRoutes } from "../../src/providers/http.ts";
import { setupRoutes } from "../../src/setup/http.ts";
import { ServerUpgrades } from "../../src/upgrade/control.ts";
import { authFixture } from "./fixture.ts";

// Serves the operator, auth, setup, and provider routes behind the real guard, with stub handlers.
const fixture = Effect.gen(function* () {
  const services = yield* authFixture();
  const auth = services.authentication;
  const currentLink = yield* auth.link;
  const link = new URL(currentLink);
  const browser = yield* auth.consumeLink(
    new URLSearchParams(link.hash.slice(1)).get("link") ?? "",
  );
  const session = Redacted.value(browser.secret);
  const busContext = yield* Layer.build(changeBusLayer);
  const bus = Context.get(busContext, ChangeBus);
  const authenticated = authenticatedRoutes(services);
  const setup = setupRoutes(
    {
      running: true,
      status: Effect.die("unused"),
      activate: Effect.die("unused"),
      changed: Effect.never,
      begin: () => Effect.die("unused"),
      exchange: () => Effect.die("unused"),
      restore: () => Effect.die("unused"),
    },
    auth.origin,
  );
  const logins = Layer.succeed(ProviderLogins, {
    status: Effect.succeed({ targets: [], logins: [] }),
    begin: () => Effect.die("unused begin"),
    submit: () => Effect.void,
    cancel: () => Effect.void,
    apiKey: () => Effect.void,
    disconnect: () => Effect.void,
  });
  const upgrades = Layer.mock(ServerUpgrades)({
    status: Effect.succeed(
      UpgradeView.make({
        running: "1.0.0",
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
  const routes = Layer.mergeAll(
    apiRoutes.pipe(
      Layer.provide(Layer.succeed(ChangeBus, bus)),
      Layer.provide(authenticated.guard.layer),
    ),
    setup.protected.pipe(Layer.provide(authenticated.guard.layer)),
    providerRoutes.pipe(Layer.provide(authenticated.guard.layer)),
    authenticated.routes,
  ).pipe(
    HttpRouter.provideRequest(Layer.mergeAll(Layer.mock(FactoryBackend)({}), upgrades, logins)),
  );
  const app = HttpRouter.toWebHandler(routes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
  const device = Effect.fn(function* (
    operations: Option.Option<ReadonlyArray<string>>,
    options: {
      readonly scopes?: ReadonlyArray<PermissionGrant>;
      readonly expiresAt?: number;
    } = {},
  ) {
    const issued = yield* auth.createToken(session, {
      name: TokenName.make("Agent"),
      scopes: options.scopes ?? administratorPermissions,
      operations: Option.map(operations, (ids) => ids.map((id) => OperationId.make(id))),
      expiresAt: Option.fromUndefinedOr(options.expiresAt),
    });
    return Redacted.value(issued.secret);
  });
  const tokenId = (token: string) =>
    auth.authenticate(token).pipe(Effect.map((access) => Option.getOrThrow(access.token).id));
  const send = (token: string, method: string, path: string, body?: string) =>
    Effect.promise(() => {
      const options: RequestInit = {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      };
      if (body !== undefined) options.body = body;
      return app.handler(new Request(`https://usine.example${path}`, options));
    });
  // Returns the status and, for a refusal by the operation ceiling, the operation it names.
  const outcome = (token: string, method: string, path: string, body?: string) =>
    send(token, method, path, body).pipe(
      Effect.flatMap((response) =>
        Effect.promise(() => response.text()).pipe(
          Effect.map((text) => {
            const refused = /This token cannot call ([a-zA-Z.]+)\./u.exec(text)?.[1];
            return refused === undefined ? response.status : `${response.status} ${refused}`;
          }),
        ),
      ),
    );
  // Returns the outcome of each request, in order.
  const outcomes = (
    requests: ReadonlyArray<readonly [token: string, method: string, path: string, body?: string]>,
  ) =>
    Effect.forEach(requests, ([token, method, path, body]) => outcome(token, method, path, body));
  return { services, session, bus, device, tokenId, send, outcomes };
});

const decoder = new TextDecoder();
// Reads the next chunk of a change stream, or `closed` when the stream ends or fails.
const nextFrame = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  Effect.promise(() =>
    reader.read().then(
      ({ done, value }) => (done ? "closed" : decoder.decode(value)),
      () => "closed",
    ),
  );

describe("operation ceiling guard", () => {
  it.live("identifies an operation by its method as well as its path", () =>
    Effect.gen(function* () {
      const { device, outcomes } = yield* fixture;
      const tokens = yield* device(Option.some(["authentication.tokens"]));
      const members = yield* device(Option.some(["authentication.members"]));
      const child =
        '{"name":"Child","scopes":[{"permission":"admin","scope":{"_tag":"Instance"}}]}';
      const results = yield* outcomes([
        [tokens, "GET", "/api/tokens"],
        [tokens, "POST", "/api/tokens", child],
        [members, "GET", "/api/members"],
        [members, "POST", "/api/members", '{"login":"bob"}'],
      ]);
      assert.deepEqual(results, [
        200,
        "403 authentication.createToken",
        200,
        "403 authentication.addMember",
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("enforces the ceiling on setup and provider routes", () =>
    Effect.gen(function* () {
      const { device, outcomes } = yield* fixture;
      const approver = yield* device(Option.some(["operator.approve"]));
      const admitted = yield* device(
        Option.some(["setup.runtime", "providers.status", "providers.cancel"]),
      );
      const results = yield* outcomes([
        [approver, "GET", "/api/setup/runtime"],
        [approver, "GET", "/api/providers"],
        [approver, "DELETE", "/api/providers/login/x"],
        [admitted, "GET", "/api/setup/runtime"],
        [admitted, "GET", "/api/providers"],
        [admitted, "DELETE", "/api/providers/login/x"],
      ]);
      assert.deepEqual(results, [
        "403 setup.runtime",
        "403 providers.status",
        "403 providers.cancel",
        200,
        200,
        200,
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("compares full operation IDs, so a repeated identifier admits one group only", () =>
    Effect.gen(function* () {
      const { device, outcomes } = yield* fixture;
      const cancel = yield* device(Option.some(["operator.cancel"]));
      const status = yield* device(Option.some(["setup.status"]));
      const results = yield* outcomes([
        [cancel, "DELETE", "/api/providers/login/x"],
        [status, "GET", "/api/providers"],
      ]);
      assert.deepEqual(results, ["403 providers.cancel", "403 providers.status"]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps a ceiling token from widening another token through a scope edit", () =>
    Effect.gen(function* () {
      const { services, device, tokenId, outcomes } = yield* fixture;
      const caller = yield* device(
        Option.some(["authentication.setScopes", "authentication.tokens"]),
      );
      const reader = [PermissionGrant.make({ permission: "read", scope: InstanceScope.make() })];
      const open = yield* device(Option.none(), { scopes: reader });
      const wider = yield* device(Option.some(["operator.overview"]), { scopes: reader });
      const within = yield* device(Option.some(["authentication.tokens"]), { scopes: reader });
      const admin = '{"scopes":[{"permission":"admin","scope":{"_tag":"Instance"}}]}';
      const [openId, widerId, withinId] = yield* Effect.forEach([open, wider, within], tokenId);
      const results = yield* outcomes([
        [caller, "PUT", `/api/tokens/${openId}/scopes`, admin],
        [caller, "PUT", `/api/tokens/${widerId}/scopes`, admin],
        [caller, "PUT", `/api/tokens/${withinId}/scopes`, admin],
      ]);
      assert.deepEqual(results, [403, 403, 200]);
      const unchanged = yield* services.authentication.authenticate(open);
      assert.deepEqual(
        unchanged.permissions.map(({ permission }) => permission),
        ["read"],
      );
      assert.isTrue(Option.isNone(unchanged.operations));
    }).pipe(Effect.scoped),
  );

  it.live("keeps a device token with an expiry from creating a token that outlives it", () =>
    Effect.gen(function* () {
      const { device, outcomes } = yield* fixture;
      const now = yield* Clock.currentTimeMillis;
      const expiresAt = now + 3_600_000;
      const caller = yield* device(Option.none(), { expiresAt });
      const lasting = yield* device(Option.none());
      const child = (expiry?: number) => {
        const request = {
          name: "Child",
          scopes: [{ permission: "read", scope: { _tag: "Instance" } }],
        };
        return jsonKey(expiry === undefined ? request : { ...request, expiresAt: expiry });
      };
      const results = yield* outcomes([
        [caller, "POST", "/api/tokens", child()],
        [caller, "POST", "/api/tokens", child(expiresAt + 1)],
        [caller, "POST", "/api/tokens", child(expiresAt)],
        [caller, "POST", "/api/tokens", child(now + 60_000)],
        [lasting, "POST", "/api/tokens", child()],
      ]);
      assert.deepEqual(results, [403, 403, 200, 200, 200]);
    }).pipe(Effect.scoped),
  );

  it.live("serves public operations to a token whose ceiling omits them", () =>
    Effect.gen(function* () {
      const { device, outcomes } = yield* fixture;
      const approver = yield* device(Option.some(["operator.approve"]));
      const results = yield* outcomes([
        [approver, "GET", "/api/version"],
        [approver, "GET", "/api/overview"],
      ]);
      assert.deepEqual(results, [200, "403 operator.overview"]);
    }).pipe(Effect.scoped),
  );

  it.live("closes an open change stream when the token's ceiling narrows", () =>
    Effect.gen(function* () {
      const { services, session, bus, device, send } = yield* fixture;
      const token = yield* device(Option.some(["operator.changes", "operator.overview"]));
      const access = yield* services.authentication.authenticate(token);
      const id = Option.getOrThrow(access.token).id;
      const response = yield* send(token, "GET", "/api/changes");
      assert.equal(response.status, 200);
      const reader = response.body?.getReader();
      assert(reader !== undefined);
      // Cancelling a stream that the server failed rejects with the server's error.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => reader.cancel().catch(() => undefined)),
      );
      const opened = yield* nextFrame(reader);
      assert.include(opened, ": heartbeat");
      const publish = bus.publish([
        { audience: InstanceScope.make(), target: { kind: "project", id: "workspace" } },
      ]);
      yield* publish;
      const notice = yield* nextFrame(reader);
      assert.include(notice, '"kind":"project","id":"workspace"');
      yield* services.authentication.setScopes(
        session,
        id,
        administratorPermissions,
        OperationCeilingChange.Replace({ operations: [OperationId.make("operator.overview")] }),
      );
      const reopened = yield* send(token, "GET", "/api/changes");
      assert.equal(reopened.status, 403);
      yield* publish;
      const afterNarrowing = yield* nextFrame(reader);
      assert.equal(afterNarrowing, "closed");
    }).pipe(Effect.timeout("10 seconds"), Effect.scoped),
  );
});
