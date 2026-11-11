import { assert, describe, it } from "@effect/vitest";
import { administratorPermissions, InstanceScope } from "@usine/core/access";
import { ChangeBus, changeBusLayer } from "@usine/core/changes";
import { UpgradeView } from "@usine/orchestrator/operator/http";
import { Context, Effect, Layer, Option, Redacted } from "effect";
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
  const device = Effect.fn(function* (operations: ReadonlyArray<string>) {
    const issued = yield* auth.createToken(session, {
      name: TokenName.make("Agent"),
      scopes: administratorPermissions,
      operations: Option.some(operations.map((operation) => OperationId.make(operation))),
      expiresAt: Option.none(),
    });
    return Redacted.value(issued.secret);
  });
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
  return { services, session, bus, device, send, outcomes };
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
      const tokens = yield* device(["authentication.tokens"]);
      const members = yield* device(["authentication.members"]);
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
      const approver = yield* device(["operator.approve"]);
      const admitted = yield* device(["setup.runtime", "providers.status", "providers.cancel"]);
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
      const cancel = yield* device(["operator.cancel"]);
      const status = yield* device(["setup.status"]);
      const results = yield* outcomes([
        [cancel, "DELETE", "/api/providers/login/x"],
        [status, "GET", "/api/providers"],
      ]);
      assert.deepEqual(results, ["403 providers.cancel", "403 providers.status"]);
    }).pipe(Effect.scoped),
  );

  it.live("serves public operations to a token whose ceiling omits them", () =>
    Effect.gen(function* () {
      const { device, outcomes } = yield* fixture;
      const approver = yield* device(["operator.approve"]);
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
      const token = yield* device(["operator.changes", "operator.overview"]);
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
