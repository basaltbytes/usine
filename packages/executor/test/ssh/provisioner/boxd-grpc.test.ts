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
import { BoxdApi, type BoxdCreate } from "../../../src/ssh/provisioner/boxd/client.ts";
import { boxdDriverFor } from "../../../src/ssh/provisioner/boxd.ts";
import { boxdApiLayer, failureCode } from "../../../src/ssh/provisioner/boxd/grpc-client.ts";

/** An endpoint override that skips region discovery; the tests fail before any gRPC call. */
const UNUSED_ENDPOINT = "http://127.0.0.1:1";

it.effect(
  "decodes real gRPC responses, shares authentication, retains proxy metadata, and sanitizes refusals",
  () =>
    Effect.gen(function* () {
      const key = "bxd_test_transport_key";
      let jwt = "test-jwt";
      const machine = {
        vmId: "vm-1",
        publicIp: "198.51.100.40",
        status: "running",
        sshPort: 12001,
        createdAt: 1_700_000_000n,
        labels: { "usine.worker": "worker" },
        egressAllow: new Array<string>(),
      };
      const selectors: Array<Array<string>> = [];
      const calls: Array<string> = [];
      let refused = false;
      let region = "fra";
      let hostKey = "ssh-ed25519 AAAAProxyKey";
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
                },
              }),
              listRegions: () => ({ thisRegion: region }),
              createVmFromSnapshot: (request) => {
                assert.strictEqual(request.config?.network?.ssh, true);
                assert.strictEqual(request.isolated, true);
                if (refused) throw new ConnectError(`quota: ${key} ${jwt}`, Code.ResourceExhausted);
                return { vmId: machine.vmId, machine };
              },
              getVm: () => machine,
              listVms: (request) => {
                selectors.push(request.labelSelector);
                return { vms: [machine], sshHostKey: hostKey };
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
        const [identity, regions, snapshot, limit] = yield* Effect.all(
          [api.whoami, api.regions, api.snapshot("usine"), api.orgMachineLimit],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(identity.userId, "member");
        assert.strictEqual(regions.thisRegion, "fra");
        assert.strictEqual(snapshot.memoryBytes, 8 * 1024 ** 3);
        assert.strictEqual(limit.maxVms, 50);
        const request: BoxdCreate = {
          snapshot: "usine",
          name: "worker",
          isolated: true,
          labels: {},
          config: { network: { ssh: true } },
        };
        const created = yield* api.createFromSnapshot(request);
        assert.strictEqual(created.id, "vm-1");
        const vm = yield* api.vm(created.id);
        assert.strictEqual(vm.createdAt, 1_700_000_000);
        yield* api.listVms(["usine.worker=worker"]);
        const proxyKey = yield* api.sshHostKey;
        assert.strictEqual(proxyKey, hostKey);
        yield* api.updateLabels(created.id, { "usine.attempts": "2" });
        assert.deepStrictEqual(vm.egressAllow, []);
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
        for (const malformed of [
          "",
          "ssh-ed25519",
          "ssh-dss AAAA",
          "ecdsa-sha2-nistp256 AAAA",
          "ssh-ed25519 AAAA\ninjected ssh-rsa AAAA",
          "ssh-ed25519 AAAA\rinjected ssh-rsa AAAA",
        ]) {
          hostKey = malformed;
          const missingKey = yield* api.sshHostKey.pipe(Effect.flip);
          assert.strictEqual(missingKey.code, "INTERNAL");
        }
        yield* TestClock.adjust("3541 seconds");
        yield* api.whoami;
        assert.strictEqual(exchanges, 2, "refreshes the session before its expiry");
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
          }) satisfies typeof boxdApiLayer;
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
          assert.deepStrictEqual((yield* driver.verify(WORKER, 2)).warnings, []);
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

for (const [status, code] of [
  [401, "UNAUTHENTICATED"],
  [403, "PERMISSION_DENIED"],
  [429, "RESOURCE_EXHAUSTED"],
  [503, "UNAVAILABLE"],
] as const) {
  it.effect(`maps token exchange HTTP ${status} to ${code} at preflight`, () =>
    Effect.gen(function* () {
      const api = yield* BoxdApi;
      const failure = yield* api.whoami.pipe(Effect.flip);
      assert.strictEqual(failure.operation, "authenticate");
      assert.strictEqual(failure.code, code);
      const driver = yield* boxdDriverFor(WORKER, boxdSettings());
      const preflight = yield* driver.verify(WORKER, 1).pipe(Effect.flip);
      assert.include(
        preflight.message,
        status === 401 || status === 403 ? "boxd refused the API key" : code,
      );
      if (status === 429 || status === 503) {
        assert.include(preflight.message, "app.boxd.sh");
        assert.notInclude(preflight.message, "snapshots save");
      }
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
      const regions = yield* Effect.gen(function* () {
        const api = yield* BoxdApi;
        yield* api.whoami;
        yield* api.orgMachineLimit;
        return yield* api.regions;
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
      assert.strictEqual(regions.thisRegion, region, "verify sees the resolved endpoint's region");
      assert.deepStrictEqual(calls, [
        { method: "listRegions", baseUrl: "https://boxd.sh:9443" },
        { method: "whoami", baseUrl: "https://boxd.sh:9443" },
        { method: "getOrgMachineLimit", baseUrl: "https://boxd.sh:9443" },
        { method: "listRegions", baseUrl: endpoint },
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
      yield* api.regions;
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
    assert.include(failure.message, "boxd lists region lax without an API endpoint");
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
