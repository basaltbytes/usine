import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { assert, it } from "@effect/vitest";
import { BoxdEndpoint, BoxdRegion } from "@usine/core/worker";
import { jsonKey } from "@usine/core/json-key";
import { Clock, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { BoxdApi as BoxdService } from "../../../src/ssh/provisioner/boxd/api-pb.ts";
import { BoxdApi, type BoxdCallError } from "../../../src/ssh/provisioner/boxd/client.ts";
import {
  BOXD_API,
  exchangeUrl,
  rawKeyAllowed,
  refusesRawKey,
} from "../../../src/ssh/provisioner/boxd/endpoint.ts";
import { boxdApiLayer } from "../../../src/ssh/provisioner/boxd/grpc-client.ts";
import { machineDriversFor } from "../../../src/ssh/provisioner/drivers.ts";
import { fakeMachine, WORKER } from "../support.ts";
import { fakeBoxd } from "./fake-boxd.ts";
import { boxdAddress } from "./fixtures.ts";
import { boxdSettings, UNUSED_CLUSTER, UNUSED_EXCHANGE } from "./support.ts";

// The boxd cluster that a Worker's calls go to: its endpoints, regions, and authentication.

/** A token exchange that the test must not reach, because boxd accepts the API key itself. */
const noExchange = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.die(new Error(`unexpected token exchange at ${request.url}`)),
  ),
);

/** A token exchange that refuses the key, which a call reaches only when it carries a session. */
const refusedExchange = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }))),
  ),
);

const listedRegions = [
  { id: "fra", apiEndpoint: "https://boxd.sh:9443" },
  { id: "nyc", apiEndpoint: "https://nyc.boxd.sh:9443" },
  { id: "eu-own-1", apiEndpoint: "boxd.eu-own-1.example.test:9443" },
];

interface RoutedCall {
  readonly method: string;
  readonly baseUrl: string;
}

/**
 * Returns a transport factory that records each RPC with the endpoint that served it, and the
 * bearer of each call in `bearers`.
 */
const routedTransport = (
  calls: Array<RoutedCall>,
  regions: ReadonlyArray<{ id: string; apiEndpoint: string }> = listedRegions,
  bearers: Array<string> = [],
) =>
  (({ baseUrl }) =>
    createRouterTransport((router) => {
      const record = (method: string, context: { requestHeader: Headers }) => {
        calls.push({ method, baseUrl });
        bearers.push(context.requestHeader.get("authorization") ?? "");
      };
      router.service(BoxdService, {
        whoami: (_request, context) => {
          record("whoami", context);
          return { userId: "member" };
        },
        getOrgMachineLimit: (_request, context) => {
          record("getOrgMachineLimit", context);
          return { maxVms: 50, vmCount: 0 };
        },
        listRegions: (_request, context) => {
          record("listRegions", context);
          const served = regions.find(
            ({ apiEndpoint }) =>
              (apiEndpoint.includes("://") ? apiEndpoint : `https://${apiEndpoint}`) === baseUrl,
          );
          return { regions: [...regions], thisRegion: served?.id ?? "" };
        },
      });
    })) satisfies Parameters<typeof boxdApiLayer>[2];

it.effect("sends the API key to the default endpoint and machine RPCs to the listed region", () =>
  Effect.gen(function* () {
    for (const [region, endpoint] of [
      ["fra", "https://boxd.sh:9443"],
      ["nyc", "https://nyc.boxd.sh:9443"],
      ["eu-own-1", "https://boxd.eu-own-1.example.test:9443"],
    ] as const) {
      const calls: Array<RoutedCall> = [];
      const bearers: Array<string> = [];
      const cluster = { endpoint: BOXD_API, region: Option.some(BoxdRegion.make(region)) };
      const servedRegion = yield* Effect.gen(function* () {
        const api = yield* BoxdApi;
        yield* api.whoami;
        yield* api.orgMachineLimit;
        return yield* api.servedRegion;
      }).pipe(
        Effect.provide(
          boxdApiLayer(
            Redacted.make("key"),
            cluster,
            routedTransport(calls, listedRegions, bearers),
          ).pipe(Layer.provide(noExchange)),
        ),
      );
      assert.strictEqual(servedRegion, region, "the listing resolved the endpoint of the region");
      const served = yield* BoxdApi.pipe(
        Effect.map((api) => api.endpoint),
        Effect.provide(
          boxdApiLayer(Redacted.make("key"), cluster, routedTransport([])).pipe(
            Layer.provide(noExchange),
          ),
        ),
      );
      assert.strictEqual(served, endpoint, "Exec calls go to the region's endpoint");
      assert.deepStrictEqual(calls, [
        { method: "listRegions", baseUrl: "https://boxd.sh:9443" },
        { method: "whoami", baseUrl: "https://boxd.sh:9443" },
        { method: "getOrgMachineLimit", baseUrl: "https://boxd.sh:9443" },
      ]);
      assert.deepStrictEqual(bearers, ["Bearer key", "Bearer key", "Bearer key"]);
    }
  }).pipe(Effect.scoped),
);

it("derives the token exchange URL from the account endpoint as the boxd SDK does", () => {
  for (const [endpoint, exchange] of [
    [BOXD_API, "https://app.boxd.sh/api/v1/auth/token"],
    ["https://boxd.example.com:9443", "https://app.boxd.example.com/api/v1/auth/token"],
    ["https://boxd.example.com:9443/", "https://app.boxd.example.com/api/v1/auth/token"],
    ["https://boxd.example.com:9443/v1/api", "https://app.boxd.example.com/api/v1/auth/token"],
    ["http://boxd.example.com:9443", "https://app.boxd.example.com/api/v1/auth/token"],
    ["boxd.example.com:9443", "https://app.boxd.example.com/api/v1/auth/token"],
    ["https://app.boxd.example.com:8443", "https://app.boxd.example.com:8443/api/v1/auth/token"],
    ["http://localhost:9443", "http://localhost:9443/api/v1/auth/token"],
    ["localhost:9443", "http://localhost:9443/api/v1/auth/token"],
    ["https://10.0.0.5:9443", "https://10.0.0.5:9443/api/v1/auth/token"],
    ["127.0.0.1:9443", "http://127.0.0.1:9443/api/v1/auth/token"],
    ["https://[fd00::1]:9443", "https://[fd00::1]:9443/api/v1/auth/token"],
    ["https://300.1.1.1:9443", "https://app.300.1.1.1/api/v1/auth/token"],
  ] as const)
    assert.strictEqual(exchangeUrl(endpoint), exchange, endpoint);
});

it("sends the API key as the bearer only over TLS or to a loopback address", () => {
  for (const [endpoint, allowed] of [
    [BOXD_API, true],
    ["https://10.0.0.5:9443", true],
    ["boxd.example.com:9443", true],
    ["http://boxd.example.com:9443", false],
    ["http://10.0.0.5:9443", false],
    ["http://localhost:9443", true],
    ["localhost:9443", true],
    ["http://127.0.0.1:9443", true],
    ["http://[::1]:9443", true],
  ] as const)
    assert.strictEqual(rawKeyAllowed(endpoint), allowed, endpoint);
  assert.isTrue(refusesRawKey("invalid token: token is malformed"));
  assert.isTrue(refusesRawKey("API keys are accepted over TLS only"));
  assert.isFalse(refusesRawKey("API key not recognized"));
  assert.isFalse(refusesRawKey("session revoked: invalid token"));
});

it.effect("exchanges a refused key at the derived URL and sends every call to the endpoint", () =>
  Effect.gen(function* () {
    const key = "bxd_custom_key";
    const calls: Array<RoutedCall> = [];
    const bearers: Array<string> = [];
    const exchanges: Array<string> = [];
    const transport = (({ baseUrl }) =>
      createRouterTransport((router) => {
        const authorize = (method: string, context: { requestHeader: Headers }) => {
          calls.push({ method, baseUrl });
          const bearer = context.requestHeader.get("authorization") ?? "";
          bearers.push(bearer);
          if (bearer === `Bearer ${key}`)
            throw new ConnectError(`invalid token: ${key} is not a session`, Code.Unauthenticated);
        };
        router.service(BoxdService, {
          whoami: (_request, context) => {
            authorize("whoami", context);
            return { userId: "member" };
          },
          getSnapshot: (_request, context) => {
            authorize("getSnapshot", context);
            return {
              snapshot: {
                status: "ready",
                region: "",
                vcpu: 2,
                memoryBytes: 8n * 1024n ** 3n,
                storage: "local",
              },
            };
          },
          // A cluster that runs in one place lists no regions.
          listRegions: (_request, context) => {
            authorize("listRegions", context);
            return { regions: [], thisRegion: "" };
          },
          getOrgMachineLimit: (_request, context) => {
            authorize("getOrgMachineLimit", context);
            return { maxVms: 50, vmCount: 0 };
          },
        });
      })) satisfies Parameters<typeof boxdApiLayer>[2];
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          exchanges.push(request.url);
          const now = yield* Clock.currentTimeMillis;
          return HttpClientResponse.fromWeb(
            request,
            new Response(jsonKey({ token: "custom-jwt", expires_at: now / 1000 + 3600 })),
          );
        }),
      ),
    );
    const execBearers: Array<Effect.Effect<Redacted.Redacted<string>, BoxdCallError>> = [];
    const drivers = yield* machineDriversFor({
      instance: "endpoint-test",
      settings: {
        providerEndpoints: { boxd: UNUSED_CLUSTER.endpoint },
        boxdExec: (_endpoint, credential) => {
          execBearers.push(credential);
          return fakeBoxd().execLayer;
        },
        boxdClient: (token, cluster) => {
          assert.deepStrictEqual(cluster, {
            endpoint: "https://boxd.example.com:9443",
            region: Option.none(),
          });
          return boxdApiLayer(token, cluster, transport);
        },
      },
    }).pipe(Effect.provide(http));
    const driver = yield* drivers.forPreflight({
      address: {
        ...boxdAddress,
        machine: {
          _tag: "Provisioned",
          provisioner: boxdSettings({
            token: Redacted.make(key),
            endpoint: Option.some(BoxdEndpoint.make("https://boxd.example.com:9443")),
            region: Option.none(),
          }),
        },
      },
      gateway: Option.none(),
      machine: Option.none(),
    });
    const { warnings } = yield* driver.verify(WORKER, 2);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(exchanges, ["https://app.boxd.example.com/api/v1/auth/token"]);
    assert.isTrue(
      calls.every(({ baseUrl }) => baseUrl === "https://boxd.example.com:9443"),
      "every call goes to the endpoint",
    );
    assert.deepStrictEqual(
      calls.map(({ method }) => method),
      ["whoami", "whoami", "getSnapshot", "listRegions", "getOrgMachineLimit"],
    );
    assert.deepStrictEqual(bearers, [
      `Bearer ${key}`,
      "Bearer custom-jwt",
      "Bearer custom-jwt",
      "Bearer custom-jwt",
      "Bearer custom-jwt",
    ]);
    const [execBearer] = execBearers;
    assert(execBearer !== undefined);
    const execSession = yield* execBearer;
    assert.strictEqual(
      Redacted.value(execSession),
      "custom-jwt",
      "Exec calls carry the session too",
    );
    assert.lengthOf(calls, 5, "the bearer of Exec calls needs no probe");
  }).pipe(Effect.scoped, Effect.provide(fakeMachine().layer)),
);

it.effect(
  "probes with whoami before the first Exec bearer and keeps the bearer it settles on",
  () =>
    Effect.gen(function* () {
      const key = "bxd_probe_key";
      for (const refuses of [false, true]) {
        const calls: Array<RoutedCall> = [];
        const bearers: Array<string> = [];
        const transport = (({ baseUrl }) =>
          createRouterTransport((router) => {
            router.service(BoxdService, {
              whoami: (_request, context) => {
                calls.push({ method: "whoami", baseUrl });
                const bearer = context.requestHeader.get("authorization") ?? "";
                bearers.push(bearer);
                // A load balancer that terminates TLS makes boxd see a plain-text call.
                if (refuses && bearer === `Bearer ${key}`)
                  throw new ConnectError(
                    "API keys are accepted over TLS only",
                    Code.Unauthenticated,
                  );
                return { userId: "member" };
              },
            });
          })) satisfies Parameters<typeof boxdApiLayer>[2];
        const http = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              return HttpClientResponse.fromWeb(
                request,
                new Response(jsonKey({ token: "probe-jwt", expires_at: now / 1000 + 3600 })),
              );
            }),
          ),
        );
        const execBearers = yield* Effect.gen(function* () {
          const api = yield* BoxdApi;
          const first = yield* api.execBearer;
          const second = yield* api.execBearer;
          return [first, second].map(Redacted.value);
        }).pipe(
          Effect.provide(
            boxdApiLayer(
              Redacted.make(key),
              { endpoint: "https://boxd.example.com:9443", region: Option.none() },
              transport,
            ).pipe(Layer.provide(refuses ? http : noExchange)),
          ),
        );
        const expected = refuses ? "probe-jwt" : key;
        assert.deepStrictEqual(execBearers, [expected, expected], `refuses: ${refuses}`);
        assert.deepStrictEqual(
          bearers,
          refuses ? [`Bearer ${key}`, "Bearer probe-jwt"] : [`Bearer ${key}`],
          "one probe, then no more calls",
        );
      }
    }).pipe(Effect.scoped),
);

it.effect(
  "sends the session on Exec once a region refuses the key that the account endpoint took",
  () =>
    Effect.gen(function* () {
      const key = "bxd_mixed_key";
      const calls: Array<RoutedCall> = [];
      const bearers: Array<string> = [];
      const transport = (({ baseUrl }) =>
        createRouterTransport((router) => {
          const record = (method: string, context: { requestHeader: Headers }) => {
            calls.push({ method, baseUrl });
            const bearer = context.requestHeader.get("authorization") ?? "";
            bearers.push(bearer);
            return bearer;
          };
          router.service(BoxdService, {
            whoami: (_request, context) => {
              record("whoami", context);
              return { userId: "member" };
            },
            listRegions: (_request, context) => {
              record("listRegions", context);
              return {
                regions: [
                  { id: "acct", apiEndpoint: "https://account.example.test:9443" },
                  { id: "lb", apiEndpoint: "https://lb.example.test:9443" },
                ],
                thisRegion: "acct",
              };
            },
            getSnapshot: (_request, context) => {
              // A load balancer in front of the region terminates TLS, so boxd sees plain text.
              if (record("getSnapshot", context) === `Bearer ${key}`)
                throw new ConnectError("API keys are accepted over TLS only", Code.Unauthenticated);
              return {
                snapshot: {
                  status: "ready",
                  region: "lb",
                  vcpu: 2,
                  memoryBytes: 8n * 1024n ** 3n,
                  storage: "local",
                },
              };
            },
          });
        })) satisfies Parameters<typeof boxdApiLayer>[2];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return HttpClientResponse.fromWeb(
              request,
              new Response(jsonKey({ token: "mixed-jwt", expires_at: now / 1000 + 3600 })),
            );
          }),
        ),
      );
      const execBearer = yield* Effect.gen(function* () {
        const api = yield* BoxdApi;
        assert.strictEqual(api.endpoint, "https://lb.example.test:9443");
        yield* api.whoami;
        yield* api.snapshot("base");
        const bearer = yield* api.execBearer;
        return Redacted.value(bearer);
      }).pipe(
        Effect.provide(
          boxdApiLayer(
            Redacted.make(key),
            {
              endpoint: "https://account.example.test:9443",
              region: Option.some(BoxdRegion.make("lb")),
            },
            transport,
          ).pipe(Layer.provide(http)),
        ),
      );
      assert.strictEqual(execBearer, "mixed-jwt", "Exec carries the session the region takes");
      assert.deepStrictEqual(calls, [
        { method: "listRegions", baseUrl: "https://account.example.test:9443" },
        { method: "whoami", baseUrl: "https://account.example.test:9443" },
        { method: "getSnapshot", baseUrl: "https://lb.example.test:9443" },
        { method: "getSnapshot", baseUrl: "https://lb.example.test:9443" },
      ]);
      assert.deepStrictEqual(
        bearers,
        [`Bearer ${key}`, `Bearer ${key}`, `Bearer ${key}`, "Bearer mixed-jwt"],
        "the Exec bearer needs no extra call",
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "fails preflight with the key advice and no exchange when boxd refuses the key for another reason",
  () =>
    Effect.gen(function* () {
      const key = "bxd_revoked_key";
      const bearers: Array<string> = [];
      const transport = (() =>
        createRouterTransport((router) => {
          router.service(BoxdService, {
            whoami: (_request, context) => {
              bearers.push(context.requestHeader.get("authorization") ?? "");
              // A wrong or revoked key, which a session from the same key can't fix.
              throw new ConnectError("API key not recognized", Code.Unauthenticated);
            },
          });
        })) satisfies Parameters<typeof boxdApiLayer>[2];
      const drivers = yield* machineDriversFor({
        instance: "endpoint-test",
        settings: {
          boxdClient: (token, cluster) => boxdApiLayer(token, cluster, transport),
        },
      });
      const driver = yield* drivers.forPreflight({
        address: {
          ...boxdAddress,
          machine: {
            _tag: "Provisioned",
            provisioner: boxdSettings({
              token: Redacted.make(key),
              endpoint: Option.some(BoxdEndpoint.make("https://boxd.example.com:9443")),
              region: Option.none(),
            }),
          },
        },
        gateway: Option.none(),
        machine: Option.none(),
      });
      for (const _ of [1, 2]) {
        const failure = yield* driver.verify(WORKER, 2).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "WorkerCapabilityError");
        assert.include(failure.message, "boxd refused the API key");
        assert.notInclude(failure.message, key);
      }
      assert.deepStrictEqual(
        bearers,
        [`Bearer ${key}`, `Bearer ${key}`],
        "every call keeps the API key, so boxd's refusal didn't switch the worker to sessions",
      );
    }).pipe(Effect.scoped, Effect.provide([noExchange, fakeMachine().layer])),
);

it.effect("sends every call to the account endpoint without a region", () =>
  Effect.gen(function* () {
    const calls: Array<RoutedCall> = [];
    const served = yield* Effect.gen(function* () {
      const api = yield* BoxdApi;
      assert.strictEqual(api.endpoint, "https://boxd.example.com:9443");
      yield* api.whoami;
      return yield* api.servedRegion;
    }).pipe(
      Effect.provide(
        boxdApiLayer(
          Redacted.make("key"),
          { endpoint: "https://boxd.example.com:9443", region: Option.none() },
          routedTransport(calls, []),
        ).pipe(Layer.provide(noExchange)),
      ),
    );
    assert.strictEqual(served, "", "boxd runs in one place");
    assert.deepStrictEqual(calls, [
      { method: "whoami", baseUrl: "https://boxd.example.com:9443" },
      { method: "listRegions", baseUrl: "https://boxd.example.com:9443" },
    ]);
  }).pipe(Effect.scoped),
);

/** Returns the boxd Worker entry with the region `region`. */
const boxdIn = (region: string) => ({
  address: {
    ...boxdAddress,
    machine: {
      _tag: "Provisioned" as const,
      provisioner: boxdSettings({ region: Option.some(BoxdRegion.make(region)) }),
    },
  },
  gateway: Option.none(),
  machine: Option.none(),
});

it.effect("fails preflight with the listed region ids when boxd lists no configured region", () =>
  Effect.gen(function* () {
    const calls: Array<RoutedCall> = [];
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: (token, cluster) => boxdApiLayer(token, cluster, routedTransport(calls)),
      },
    });
    const failure = yield* drivers.forEntry(boxdIn("lax")).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "WorkerCapabilityError");
    assert.include(failure.message, 'boxd has no region "lax"');
    assert.include(failure.message, "fra, nyc, eu-own-1");
    assert.deepStrictEqual(calls, [{ method: "listRegions", baseUrl: "https://boxd.sh:9443" }]);
  }).pipe(Effect.scoped, Effect.provide([noExchange, fakeMachine().layer])),
);

it.effect("fails preflight when a cluster that runs in one place gets a region", () =>
  Effect.gen(function* () {
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: (token, cluster) => boxdApiLayer(token, cluster, routedTransport([], [])),
      },
    });
    const failure = yield* drivers.forPreflight(boxdIn("fra")).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "WorkerCapabilityError");
    assert.include(failure.message, "runs in one place");
    assert.include(failure.message, "Remove provisioner.region");
  }).pipe(Effect.scoped, Effect.provide([noExchange, fakeMachine().layer])),
);

it.effect("fails preflight when boxd lists the configured region without an API endpoint", () =>
  Effect.gen(function* () {
    const calls: Array<RoutedCall> = [];
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: (token, cluster) =>
          boxdApiLayer(
            token,
            cluster,
            routedTransport(calls, [...listedRegions, { id: "lax", apiEndpoint: "" }]),
          ),
      },
    });
    const failure = yield* drivers.forEntry(boxdIn("lax")).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "WorkerCapabilityError");
    assert.include(failure.message, 'boxd has no region "lax" with an API endpoint');
    assert.include(failure.message, "regions boxd lists: fra, nyc, eu-own-1.");
    assert.deepStrictEqual(calls, [{ method: "listRegions", baseUrl: "https://boxd.sh:9443" }]);
  }).pipe(Effect.scoped, Effect.provide([noExchange, fakeMachine().layer])),
);

it.effect(
  "fails preflight with the key advice when boxd refuses the key while listing regions",
  () =>
    Effect.gen(function* () {
      const drivers = yield* machineDriversFor({
        instance: "regions-test",
        settings: { providerEndpoints: { boxd: UNUSED_CLUSTER.endpoint } },
      });
      const failure = yield* drivers
        .forEntry({ address: boxdAddress, gateway: Option.none(), machine: Option.none() })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WorkerCapabilityError");
      assert.include(failure.message, "boxd refused the API key");
    }).pipe(Effect.scoped, Effect.provide([refusedExchange, fakeMachine().layer])),
);

for (const [status, reason] of [
  [503, "unreachable"],
  [429, "quota"],
] as const) {
  it.effect(
    `fails the launch with a retryable ${reason} unavailability when the token exchange returns HTTP ${status}`,
    () =>
      Effect.gen(function* () {
        const drivers = yield* machineDriversFor({
          instance: "regions-test",
          settings: { providerEndpoints: { boxd: UNUSED_CLUSTER.endpoint } },
        });
        const failure = yield* drivers
          .forEntry({ address: boxdAddress, gateway: Option.none(), machine: Option.none() })
          .pipe(Effect.flip);
        assert(failure._tag === "MachineUnavailableError");
        assert.strictEqual(failure.provider, "boxd");
        assert.strictEqual(failure.reason, reason);
        assert.include(failure.message, "authenticate");
        assert.include(failure.message, UNUSED_EXCHANGE);
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

it.effect("refuses to build Exec for a region that boxd lists at a plain-text API endpoint", () =>
  Effect.gen(function* () {
    let execBuilds = 0;
    const drivers = yield* machineDriversFor({
      instance: "regions-test",
      settings: {
        boxdClient: (token, cluster) =>
          boxdApiLayer(
            token,
            cluster,
            routedTransport(
              [],
              [...listedRegions, { id: "lan", apiEndpoint: "http://boxd.lan.example.test:9443" }],
            ),
          ),
        boxdExec: () => {
          execBuilds++;
          return fakeBoxd().execLayer;
        },
      },
    });
    for (const failure of [
      yield* drivers.forEntry(boxdIn("lan")).pipe(Effect.flip),
      yield* drivers.forPreflight(boxdIn("lan")).pipe(Effect.flip),
    ]) {
      assert.strictEqual(failure._tag, "WorkerCapabilityError");
      assert.include(failure.message, "http://boxd.lan.example.test:9443 without TLS");
      assert.notInclude(failure.message, "bxd_test_key");
    }
    assert.strictEqual(execBuilds, 0, "no Exec call can carry the key in clear text");
  }).pipe(Effect.scoped, Effect.provide([noExchange, fakeMachine().layer])),
);
