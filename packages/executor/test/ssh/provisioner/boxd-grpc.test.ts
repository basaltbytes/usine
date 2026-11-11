import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { assert, it } from "@effect/vitest";
import { BoxdRegion, MachineId, WorkerName } from "@usine/core/worker";
import { Clock, Deferred, Effect, Fiber, Layer, Option, Predicate, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createServer } from "node:http2";
import { createServer as createTcpServer } from "node:net";
import { TestClock } from "effect/testing";
import { machineDriversFor } from "../../../src/ssh/provisioner/drivers.ts";
import { fakeMachine, WORKER } from "../support.ts";
import { boxdAddress, hetznerAddress } from "./fixtures.ts";
import { fakeBoxd } from "./fake-boxd.ts";
import { boxdSettings } from "./support.ts";
import { jsonKey } from "@usine/core/json-key";
import { BoxdApi as BoxdService } from "../../../src/ssh/provisioner/boxd/api-pb.ts";
import {
  BoxdApi,
  type BoxdApiLayer,
  BoxdCallError,
  type BoxdCreate,
} from "../../../src/ssh/provisioner/boxd/client.ts";
import { boxdDriverFor } from "../../../src/ssh/provisioner/boxd.ts";
import { boxdApiLayer } from "../../../src/ssh/provisioner/boxd/grpc-client.ts";
import { failureCode } from "../../../src/ssh/provisioner/boxd/status.ts";

/** An endpoint override that skips region discovery; the tests fail before any gRPC call. */
const UNUSED_ENDPOINT = "http://127.0.0.1:1";

it.effect("decodes real gRPC responses, shares authentication, and sanitizes refusals", () =>
  Effect.gen(function* () {
    const key = "bxd_test_transport_key";
    let jwt = "test-jwt";
    const machine = {
      vmId: "vm-1",
      status: "running",
      createdAt: 1_700_000_000n,
      labels: { "usine.worker": "worker" },
      egressAllow: new Array<string>(),
    };
    const selectors: Array<Array<string>> = [];
    const calls: Array<string> = [];
    let refused = false;
    let region = "fra";
    const server = createServer(
      connectNodeAdapter({
        routes: (router) =>
          router.service(BoxdService, {
            whoami: (_request, context) => {
              assert.strictEqual(context.requestHeader.get("authorization"), `Bearer ${jwt}`);
              const timeout = context.timeoutMs();
              assert.isDefined(timeout);
              assert.isAtMost(timeout ?? Infinity, 30_000);
              return { userId: "member" };
            },
            getOrgMachineLimit: () => ({ maxVms: 50, vmCount: 2 }),
            getSnapshot: () => ({
              snapshot: {
                status: "ready",
                region,
                vcpu: 2,
                memoryBytes: 8n * 1024n ** 3n,
                storage: "archived",
              },
            }),
            listRegions: () => ({ thisRegion: region }),
            createVmFromSnapshot: (request) => {
              assert.strictEqual(request.config?.network?.ssh, true);
              assert.strictEqual(request.spec?.version, 1);
              assert.strictEqual(request.spec?.isolated, true);
              assert.deepStrictEqual(request.spec?.labels, { "usine.worker": "worker" });
              if (refused) throw new ConnectError(`quota: ${key} ${jwt}`, Code.ResourceExhausted);
              machine.egressAllow = request.spec?.egress ?? [];
              return { vmId: machine.vmId, machine };
            },
            getVm: () => machine,
            listVms: (request) => {
              selectors.push(request.labelSelector);
              return { vms: [machine] };
            },
            updateVmLabels: () => {
              calls.push("labels");
              return {};
            },
            destroyVm: () => {
              calls.push("destroy");
              return {};
            },
            setVmEgressAllow: (request) => {
              calls.push(`egress ${request.vm} ${request.entries.join(",")}`);
              machine.egressAllow = request.entries;
              return { entries: request.entries };
            },
            setAutoHibernateTimeout: (request) => {
              assert.strictEqual(request.timeoutSecs, 0);
              calls.push("hibernate");
              return {};
            },
            setAutoSuspendTimeout: (request) => {
              assert.strictEqual(request.timeoutSecs, 0);
              calls.push("suspend");
              return {};
            },
          }),
      }),
    );
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.once("error", (cause) => resume(Effect.die(cause)));
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
        }),
    );
    const address = server.address();
    assert(address !== null && !Predicate.isString(address));
    let exchanges = 0;
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          exchanges++;
          jwt = `test-jwt-${exchanges}`;
          assert.strictEqual(request.url, "https://app.boxd.sh/api/v1/auth/token");
          assert(request.body._tag === "Uint8Array");
          assert.strictEqual(
            new TextDecoder().decode(request.body.body),
            jsonKey({ api_key: key }),
          );
          const now = yield* Clock.currentTimeMillis;
          return HttpClientResponse.fromWeb(
            request,
            new Response(jsonKey({ token: jwt, expires_at: now / 1000 + 3600 }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    const layer = boxdApiLayer(
      Redacted.make(key),
      BoxdRegion.make("fra"),
      `http://127.0.0.1:${address.port}`,
    ).pipe(Layer.provide(http));
    yield* Effect.gen(function* () {
      const api = yield* BoxdApi;
      const [identity, served, snapshot, limit] = yield* Effect.all(
        [api.whoami, api.servedRegion, api.snapshot("usine"), api.orgMachineLimit],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(identity.userId, "member");
      assert.strictEqual(api.endpoint, `http://127.0.0.1:${address.port}`);
      assert.strictEqual(served, "fra");
      assert.strictEqual(snapshot.memoryBytes, 8 * 1024 ** 3);
      assert.strictEqual(snapshot.storage, "archived");
      assert.strictEqual(limit.maxVms, 50);
      const request: BoxdCreate = {
        snapshot: "usine",
        name: "worker",
        isolated: true,
        labels: { "usine.worker": "worker" },
        egress: ["*.tailscale.com"],
      };
      const created = yield* api.createFromSnapshot(request);
      assert.strictEqual(created.id, "vm-1");
      assert.deepStrictEqual(
        Option.map(created.machine, ({ egressAllow }) => egressAllow),
        Option.some(["*.tailscale.com"]),
        "the create response reports the allowlist of the spec",
      );
      const vm = yield* api.vm(created.id);
      assert.strictEqual(vm.createdAt, 1_700_000_000);
      yield* api.listVms(["usine.worker=worker"]);
      yield* api.updateLabels(created.id, { "usine.attempts": "2" });
      assert.deepStrictEqual(vm.egressAllow, ["*.tailscale.com"]);
      const inEffect = yield* api.setEgressAllow(created.id, [
        "*.tailscale.com",
        "registry.npmjs.org",
      ]);
      assert.deepStrictEqual(inEffect, ["*.tailscale.com", "registry.npmjs.org"]);
      const restricted = yield* api.vm(created.id);
      assert.deepStrictEqual(restricted.egressAllow, inEffect);
      yield* api.setAutoHibernateTimeout(created.id, 0);
      yield* api.setAutoSuspendTimeout(created.id, 0);
      yield* api.destroy(MachineId.make("vm-1"));
      refused = true;
      const error = yield* api.createFromSnapshot(request).pipe(Effect.flip);
      assert.strictEqual(error.code, "RESOURCE_EXHAUSTED");
      assert.notInclude(error.message, key);
      assert.notInclude(error.message, jwt);
      yield* TestClock.adjust("3299 seconds");
      yield* api.whoami;
      assert.strictEqual(exchanges, 1, "keeps the session until 300 seconds before its expiry");
      yield* TestClock.adjust("2 seconds");
      yield* api.whoami;
      assert.strictEqual(exchanges, 2, "refreshes the session 300 seconds before its expiry");
    }).pipe(Effect.provide(layer));
    assert.strictEqual(exchanges, 2);
    assert.deepStrictEqual(selectors[0], ["usine.worker=worker"]);
    assert.deepStrictEqual(calls, [
      "labels",
      "egress vm-1 *.tailscale.com,registry.npmjs.org",
      "hibernate",
      "suspend",
      "destroy",
    ]);
    const host = fakeMachine();
    const ambient = fakeBoxd();
    ambient.state.keyRefused = true;
    for (const selectedRegion of [BoxdRegion.make("fra"), BoxdRegion.make("nyc")]) {
      region = selectedRegion;
      yield* Effect.gen(function* () {
        const settings = { providerEndpoints: { boxd: `http://127.0.0.1:${address.port}` } };
        const boxdClient = ((token, region, endpoint) => {
          assert.strictEqual(region, selectedRegion);
          assert.strictEqual(Redacted.value(token), key);
          return boxdApiLayer(token, region, endpoint);
        }) satisfies BoxdApiLayer;
        const drivers = yield* machineDriversFor({
          instance: "transport-test",
          settings: selectedRegion === "nyc" ? { ...settings, boxdClient } : settings,
        });
        const driver = yield* drivers.forEntry({
          address: {
            ...boxdAddress,
            machine: {
              _tag: "Provisioned",
              provisioner: boxdSettings({ token: Redacted.make(key), region: selectedRegion }),
            },
          },
          gateway: Option.none(),
          machine: Option.none(),
        });
        const { warnings } = yield* driver.verify(WORKER, 2);
        assert.lengthOf(warnings, 1);
        assert.include(warnings[0], '"usine-attempt" is archived');
      }).pipe(Effect.provide([http, host.layer, ambient.layer]));
    }
    assert.strictEqual(exchanges, 4, "each production factory builds the configured transport");
  }).pipe(Effect.scoped),
);

it.effect("times out a stalled token exchange and releases the lock for waiting callers", () =>
  Effect.gen(function* () {
    let exchanges = 0;
    const started = yield* Deferred.make<void>();
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          exchanges++;
          if (exchanges === 1) {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }
          yield* Effect.sleep("5 seconds");
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }));
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const api = yield* BoxdApi;
      const identity = yield* api.whoami.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      const machines = yield* api.listVms([]).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(identity)).code, "UNAVAILABLE");
      assert.strictEqual(exchanges, 2, "the waiting call starts another exchange after timeout");
      yield* TestClock.adjust("5 seconds");
      const failure = yield* Fiber.join(machines);
      assert.strictEqual(failure.operation, "authenticate");
      assert.strictEqual(failure.code, "UNAUTHENTICATED");
    }).pipe(
      Effect.provide(
        boxdApiLayer(Redacted.make("key"), BoxdRegion.make("fra"), UNUSED_ENDPOINT).pipe(
          Layer.provide(http),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("exchanges the key again and retries once when boxd refuses a session early", () =>
  Effect.gen(function* () {
    let exchanges = 0;
    const refused = new Set(["jwt-1"]);
    const seen: Array<string> = [];
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          exchanges++;
          const now = yield* Clock.currentTimeMillis;
          return HttpClientResponse.fromWeb(
            request,
            new Response(jsonKey({ token: `jwt-${exchanges}`, expires_at: now / 1000 + 3600 })),
          );
        }),
      ),
    );
    const transport = (() =>
      createRouterTransport((router) => {
        router.service(BoxdService, {
          whoami: (_request, context) => {
            const jwt = (context.requestHeader.get("authorization") ?? "").replace("Bearer ", "");
            seen.push(jwt);
            if (refused.has(jwt)) throw new ConnectError("session revoked", Code.Unauthenticated);
            return { userId: "member" };
          },
        });
      })) satisfies Parameters<typeof boxdApiLayer>[3];
    yield* Effect.gen(function* () {
      const api = yield* BoxdApi;
      assert.strictEqual((yield* api.whoami).userId, "member");
      assert.deepStrictEqual(seen, ["jwt-1", "jwt-2"]);
      assert.strictEqual(exchanges, 2);
      yield* api.whoami;
      assert.strictEqual(exchanges, 2, "keeps the new session");
      refused.add("jwt-2");
      refused.add("jwt-3");
      const failure = yield* api.whoami.pipe(Effect.flip);
      assert.strictEqual(failure.operation, "whoami");
      assert.strictEqual(failure.code, "UNAUTHENTICATED");
      assert.deepStrictEqual(seen.slice(3), ["jwt-2", "jwt-3"], "retries only once");
      assert.strictEqual(exchanges, 3);
    }).pipe(
      Effect.provide(
        boxdApiLayer(Redacted.make("key"), BoxdRegion.make("fra"), UNUSED_ENDPOINT, transport).pipe(
          Layer.provide(http),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("keeps a newer session when a late call reports an older session refused", () =>
  Effect.gen(function* () {
    let exchanges = 0;
    const refused = new Set<string>();
    const seen: Array<string> = [];
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const services = yield* Effect.context<never>();
    let holding = true;
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          exchanges++;
          const now = yield* Clock.currentTimeMillis;
          return HttpClientResponse.fromWeb(
            request,
            new Response(jsonKey({ token: `jwt-${exchanges}`, expires_at: now / 1000 + 3600 })),
          );
        }),
      ),
    );
    const bearerOf = (context: { requestHeader: Headers }) =>
      (context.requestHeader.get("authorization") ?? "").replace("Bearer ", "");
    const transport = (() =>
      createRouterTransport((router) => {
        router.service(BoxdService, {
          whoami: (_request, context) => {
            const jwt = bearerOf(context);
            seen.push(jwt);
            if (refused.has(jwt)) throw new ConnectError("session revoked", Code.Unauthenticated);
            return { userId: "member" };
          },
          listVms: (_request, context) =>
            Effect.runPromiseWith(services)(
              Effect.gen(function* () {
                const jwt = bearerOf(context);
                seen.push(jwt);
                if (holding) {
                  holding = false;
                  yield* Deferred.succeed(held, undefined);
                  yield* Deferred.await(release);
                }
                if (refused.has(jwt))
                  return yield* Effect.die(
                    new ConnectError("session revoked", Code.Unauthenticated),
                  );
                return { vms: [] };
              }),
            ),
        });
      })) satisfies Parameters<typeof boxdApiLayer>[3];
    yield* Effect.gen(function* () {
      const api = yield* BoxdApi;
      yield* api.whoami;
      assert.deepStrictEqual(seen, ["jwt-1"]);
      refused.add("jwt-1");
      const late = yield* api.listVms([]).pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const identity = yield* api.whoami;
      assert.strictEqual(identity.userId, "member");
      assert.strictEqual(exchanges, 2, "the early refusal renews the session");
      yield* Deferred.succeed(release, undefined);
      const machines = yield* Fiber.join(late);
      assert.deepStrictEqual(machines, []);
      assert.deepStrictEqual(seen, ["jwt-1", "jwt-1", "jwt-1", "jwt-2", "jwt-2"]);
      assert.strictEqual(exchanges, 2, "the late refusal keeps the newer session");
    }).pipe(
      Effect.provide(
        boxdApiLayer(Redacted.make("key"), BoxdRegion.make("fra"), UNUSED_ENDPOINT, transport).pipe(
          Layer.provide(http),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

for (const [status, code] of [
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [403, "PERMISSION_DENIED"],
  [429, "RESOURCE_EXHAUSTED"],
  [500, "INTERNAL"],
  [502, "UNAVAILABLE"],
  [503, "UNAVAILABLE"],
  [504, "UNAVAILABLE"],
  [404, "UNKNOWN"],
] as const) {
  it.effect(`maps token exchange HTTP ${status} to ${code} at preflight`, () =>
    Effect.gen(function* () {
      const api = yield* BoxdApi;
      const failure = yield* api.whoami.pipe(Effect.flip);
      assert.strictEqual(failure.operation, "authenticate");
      assert.strictEqual(failure.code, code);
      const driver = yield* boxdDriverFor(WORKER, boxdSettings()).pipe(
        Effect.provide(Layer.merge(fakeMachine().layer, fakeBoxd().execLayer)),
      );
      const preflight = yield* driver.verify(WORKER, 1).pipe(Effect.flip);
      assert.include(
        preflight.message,
        status === 401 || status === 403 ? "boxd refused the API key" : code,
      );
      assert.notInclude(preflight.message, "snapshots save");
      if (code === "RESOURCE_EXHAUSTED" || code === "UNAVAILABLE")
        assert.include(preflight.message, "app.boxd.sh");
      else assert.notInclude(preflight.message, "app.boxd.sh");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        boxdApiLayer(Redacted.make("key"), BoxdRegion.make("fra"), UNUSED_ENDPOINT).pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

it.live("classifies a reset gRPC connection as unavailable", () =>
  Effect.gen(function* () {
    const server = createTcpServer((socket) => {
      socket.once("data", () => socket.resetAndDestroy());
    });
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.once("error", (cause) => resume(Effect.die(cause)));
        server.listen(0, "127.0.0.1", () => resume(Effect.void));
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
        }),
    );
    const address = server.address();
    assert(address !== null && !Predicate.isString(address));
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          return HttpClientResponse.fromWeb(
            request,
            new Response(jsonKey({ token: "jwt", expires_at: now / 1000 + 3600 }), {
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const api = yield* BoxdApi;
      const failure = yield* api.whoami.pipe(Effect.flip);
      assert.strictEqual(failure.code, "UNAVAILABLE");
    }).pipe(
      Effect.provide(
        boxdApiLayer(
          Redacted.make("key"),
          BoxdRegion.make("fra"),
          `http://127.0.0.1:${address.port}`,
        ).pipe(Layer.provide(http)),
      ),
    );
  }).pipe(Effect.scoped),
);

it("maps socket errors that Connect reports as aborted or internal to unavailable", () => {
  for (const code of ["ECONNRESET", "ECONNABORTED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]) {
    const cause = Object.assign(new Error("connection lost"), { code });
    const error = new ConnectError("connection lost", Code.Aborted, undefined, undefined, cause);
    assert.strictEqual(failureCode(error), "UNAVAILABLE");
  }
  assert.strictEqual(failureCode(new ConnectError("bug", Code.Internal)), "INTERNAL");
  const remoteCancel = new ConnectError("server canceled request", Code.Canceled);
  remoteCancel.isWireError = true;
  assert.strictEqual(failureCode(remoteCancel), "CANCELED");
});

const sessionHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return HttpClientResponse.fromWeb(
        request,
        new Response(jsonKey({ token: "jwt", expires_at: now / 1000 + 3600 })),
      );
    }),
  ),
);

const listedRegions = [
  { id: "fra", apiEndpoint: "https://boxd.sh:9443" },
  { id: "nyc", apiEndpoint: "https://nyc.boxd.sh:9443" },
  { id: "eu-own-1", apiEndpoint: "boxd.eu-own-1.example.test:9443" },
];

/** Returns a transport factory that records each RPC with the endpoint that served it. */
const routedTransport = (
  calls: Array<{ method: string; baseUrl: string }>,
  regions: ReadonlyArray<{ id: string; apiEndpoint: string }> = listedRegions,
) =>
  (({ baseUrl }) =>
    createRouterTransport((router) => {
      router.service(BoxdService, {
        whoami: () => {
          calls.push({ method: "whoami", baseUrl });
          return { userId: "member" };
        },
        getOrgMachineLimit: () => {
          calls.push({ method: "getOrgMachineLimit", baseUrl });
          return { maxVms: 50, vmCount: 0 };
        },
        listRegions: () => {
          calls.push({ method: "listRegions", baseUrl });
          const served = regions.find(
            ({ apiEndpoint }) =>
              (apiEndpoint.includes("://") ? apiEndpoint : `https://${apiEndpoint}`) === baseUrl,
          );
          return { regions: [...regions], thisRegion: served?.id ?? "" };
        },
      });
    })) satisfies Parameters<typeof boxdApiLayer>[3];

it.effect("routes account RPCs to boxd and machine RPCs to the endpoint ListRegions lists", () =>
  Effect.gen(function* () {
    for (const [region, endpoint] of [
      ["fra", "https://boxd.sh:9443"],
      ["nyc", "https://nyc.boxd.sh:9443"],
      ["eu-own-1", "https://boxd.eu-own-1.example.test:9443"],
    ] as const) {
      const calls: Array<{ method: string; baseUrl: string }> = [];
      const servedRegion = yield* Effect.gen(function* () {
        const api = yield* BoxdApi;
        yield* api.whoami;
        yield* api.orgMachineLimit;
        return yield* api.servedRegion;
      }).pipe(
        Effect.provide(
          boxdApiLayer(
            Redacted.make("key"),
            BoxdRegion.make(region),
            undefined,
            routedTransport(calls),
          ).pipe(Layer.provide(sessionHttp)),
        ),
      );
      assert.strictEqual(servedRegion, region, "the listing resolved the endpoint of the region");
      const served = yield* BoxdApi.pipe(
        Effect.map((api) => api.endpoint),
        Effect.provide(
          boxdApiLayer(
            Redacted.make("key"),
            BoxdRegion.make(region),
            undefined,
            routedTransport([]),
          ).pipe(Layer.provide(sessionHttp)),
        ),
      );
      assert.strictEqual(served, endpoint, "Exec calls go to the region's endpoint");
      assert.deepStrictEqual(calls, [
        { method: "listRegions", baseUrl: "https://boxd.sh:9443" },
        { method: "whoami", baseUrl: "https://boxd.sh:9443" },
        { method: "getOrgMachineLimit", baseUrl: "https://boxd.sh:9443" },
      ]);
    }
  }).pipe(Effect.scoped),
);

it.effect("sends every call to the endpoint override without listing regions", () =>
  Effect.gen(function* () {
    const calls: Array<{ method: string; baseUrl: string }> = [];
    yield* Effect.gen(function* () {
      const api = yield* BoxdApi;
      yield* api.whoami;
      yield* api.servedRegion;
    }).pipe(
      Effect.provide(
        boxdApiLayer(
          Redacted.make("key"),
          BoxdRegion.make("eu-own-1"),
          "http://127.0.0.1:9443",
          routedTransport(calls),
        ).pipe(Layer.provide(sessionHttp)),
      ),
    );
    assert.deepStrictEqual(calls, [
      { method: "whoami", baseUrl: "http://127.0.0.1:9443" },
      { method: "listRegions", baseUrl: "http://127.0.0.1:9443" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("fails preflight with the listed region ids when boxd lists no configured region", () =>
  Effect.gen(function* () {
    const calls: Array<{ method: string; baseUrl: string }> = [];
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: (token, region, endpoint) =>
          boxdApiLayer(token, region, endpoint, routedTransport(calls)),
      },
    });
    const failure = yield* drivers
      .forEntry({
        address: {
          ...boxdAddress,
          machine: {
            _tag: "Provisioned",
            provisioner: boxdSettings({ region: BoxdRegion.make("lax") }),
          },
        },
        gateway: Option.none(),
        machine: Option.none(),
      })
      .pipe(Effect.flip);
    assert.strictEqual(failure._tag, "WorkerCapabilityError");
    assert.include(failure.message, 'boxd has no region "lax"');
    assert.include(failure.message, "fra, nyc, eu-own-1");
    assert.deepStrictEqual(calls, [{ method: "listRegions", baseUrl: "https://boxd.sh:9443" }]);
  }).pipe(Effect.scoped, Effect.provide([sessionHttp, fakeMachine().layer])),
);

it.effect("fails preflight when boxd lists the configured region without an API endpoint", () =>
  Effect.gen(function* () {
    const calls: Array<{ method: string; baseUrl: string }> = [];
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: (token, region, endpoint) =>
          boxdApiLayer(
            token,
            region,
            endpoint,
            routedTransport(calls, [...listedRegions, { id: "lax", apiEndpoint: "" }]),
          ),
      },
    });
    const failure = yield* drivers
      .forEntry({
        address: {
          ...boxdAddress,
          machine: {
            _tag: "Provisioned",
            provisioner: boxdSettings({ region: BoxdRegion.make("lax") }),
          },
        },
        gateway: Option.none(),
        machine: Option.none(),
      })
      .pipe(Effect.flip);
    assert.strictEqual(failure._tag, "WorkerCapabilityError");
    assert.include(failure.message, 'boxd has no region "lax" with an API endpoint');
    assert.include(failure.message, "regions boxd lists: fra, nyc, eu-own-1.");
    assert.deepStrictEqual(calls, [{ method: "listRegions", baseUrl: "https://boxd.sh:9443" }]);
  }).pipe(Effect.scoped, Effect.provide([sessionHttp, fakeMachine().layer])),
);

it.effect(
  "fails preflight with the key advice when boxd refuses the key while listing regions",
  () =>
    Effect.gen(function* () {
      const drivers = yield* machineDriversFor({ instance: "regions-test", settings: {} });
      const failure = yield* drivers
        .forEntry({ address: boxdAddress, gateway: Option.none(), machine: Option.none() })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WorkerCapabilityError");
      assert.include(failure.message, "boxd refused the API key");
    }).pipe(
      Effect.scoped,
      Effect.provide([
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
            ),
          ),
        ),
        fakeMachine().layer,
      ]),
    ),
);

for (const [status, reason] of [
  [503, "unreachable"],
  [429, "quota"],
] as const) {
  it.effect(
    `fails the launch with a retryable ${reason} unavailability when the token exchange returns HTTP ${status}`,
    () =>
      Effect.gen(function* () {
        const drivers = yield* machineDriversFor({ instance: "regions-test", settings: {} });
        const failure = yield* drivers
          .forEntry({ address: boxdAddress, gateway: Option.none(), machine: Option.none() })
          .pipe(Effect.flip);
        assert(failure._tag === "MachineUnavailableError");
        assert.strictEqual(failure.provider, "boxd");
        assert.strictEqual(failure.reason, reason);
        assert.include(failure.message, "authenticate");
        assert.notInclude(failure.message, "snapshots save");
      }).pipe(
        Effect.scoped,
        Effect.provide([
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))),
            ),
          ),
          fakeMachine().layer,
        ]),
      ),
  );
}

it.effect("builds another Worker's driver while a boxd region lookup is pending", () =>
  Effect.gen(function* () {
    const lookup = yield* Deferred.make<void>();
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: () =>
          Layer.effect(
            BoxdApi,
            Deferred.succeed(lookup, undefined).pipe(Effect.andThen(Effect.never)),
          ),
      },
    });
    const boxd = yield* drivers
      .forEntry({ address: boxdAddress, gateway: Option.none(), machine: Option.none() })
      .pipe(Effect.forkChild);
    yield* Deferred.await(lookup);
    const hetzner = yield* drivers.forEntry({
      address: { ...hetznerAddress, name: WorkerName.make("hetzner-pool") },
      gateway: Option.none(),
      machine: Option.none(),
    });
    assert.strictEqual(hetzner.provider, "hetzner");
    assert.isUndefined(boxd.pollUnsafe());
    yield* Fiber.interrupt(boxd);
  }).pipe(Effect.scoped, Effect.provide([sessionHttp, fakeMachine().layer])),
);

it.effect("builds a boxd Worker's driver once for concurrent callers", () =>
  Effect.gen(function* () {
    const boxd = fakeBoxd();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let builds = 0;
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: () => {
          builds += 1;
          return Layer.effect(
            BoxdApi,
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(boxd.api),
            ),
          );
        },
      },
    });
    const entry = { address: boxdAddress, gateway: Option.none(), machine: Option.none() };
    const first = yield* drivers.forEntry(entry).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const second = yield* drivers.forEntry(entry).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    const [one, two] = yield* Fiber.joinAll([first, second]);
    assert.strictEqual(builds, 1);
    assert.strictEqual(one, two);
  }).pipe(Effect.scoped, Effect.provide([sessionHttp, fakeMachine().layer])),
);

it.effect("fails concurrent callers together when a boxd build fails, and builds again after", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let builds = 0;
    let closed = 0;
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: () => {
          builds += 1;
          return Layer.effect(
            BoxdApi,
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => closed++));
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return yield* BoxdCallError.make({
                operation: "listRegions",
                code: "UNAVAILABLE",
                message: "boxd is down",
              });
            }),
          );
        },
      },
    });
    const entry = { address: boxdAddress, gateway: Option.none(), machine: Option.none() };
    const first = yield* drivers.forEntry(entry).pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    const second = yield* drivers.forEntry(entry).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    const one = yield* Fiber.join(first);
    const two = yield* Fiber.join(second);
    assert.strictEqual(builds, 1, "the waiting caller shares the failed build");
    assert.strictEqual(one._tag, "MachineUnavailableError");
    assert.strictEqual(two._tag, "MachineUnavailableError");
    assert.strictEqual(closed, 1, "the failed build closes what it opened");
    const preflight = yield* drivers.forPreflight(entry).pipe(Effect.flip);
    assert.strictEqual(builds, 2, "a later caller builds again");
    assert.strictEqual(preflight._tag, "WorkerCapabilityError");
    assert.include(preflight.message, "boxd didn't answer listRegions");
  }).pipe(Effect.scoped, Effect.provide([sessionHttp, fakeMachine().layer])),
);

it.effect("shares one boxd client among Worker revisions with the same key and region", () =>
  Effect.gen(function* () {
    const boxd = fakeBoxd();
    const clients: Array<string> = [];
    const execs: Array<string> = [];
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: (token, region) => {
          clients.push(`${Redacted.value(token)} ${region}`);
          return Layer.succeed(BoxdApi, boxd.api);
        },
        boxdExec: (endpoint) => {
          execs.push(endpoint);
          return boxd.execLayer;
        },
      },
    });
    const revision = (token: string) => ({
      address: {
        ...boxdAddress,
        machine: {
          _tag: "Provisioned" as const,
          provisioner: boxdSettings({ token: Redacted.make(token) }),
        },
      },
      gateway: Option.none(),
      machine: Option.none(),
    });
    const first = yield* drivers.forEntry(revision("bxd_one"));
    const second = yield* drivers.forEntry(revision("bxd_one"));
    assert.notStrictEqual(first, second, "each revision has its own driver");
    assert.deepStrictEqual(clients, ["bxd_one fra"]);
    assert.lengthOf(execs, 1);
    yield* drivers.forEntry(revision("bxd_two"));
    assert.deepStrictEqual(clients, ["bxd_one fra", "bxd_two fra"]);
    assert.lengthOf(execs, 2);
  }).pipe(Effect.scoped, Effect.provide([sessionHttp, fakeMachine().layer])),
);
