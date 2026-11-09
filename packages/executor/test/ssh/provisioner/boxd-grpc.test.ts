import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { assert, it } from "@effect/vitest";
import { MachineId } from "@usine/core/worker";
import { Clock, Deferred, Effect, Fiber, Layer, Option, Predicate, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createServer } from "node:http2";
import { createServer as createTcpServer } from "node:net";
import { TestClock } from "effect/testing";
import { machineDriversFor } from "../../../src/ssh/provisioner/drivers.ts";
import { fakeMachine, WORKER } from "../support.ts";
import { boxdAddress } from "./fixtures.ts";
import { fakeBoxd } from "./fake-boxd.ts";
import { boxdSettings } from "./support.ts";
import { jsonKey } from "@usine/core/json-key";
import { BoxdApi as BoxdService } from "../../../src/ssh/provisioner/boxd/api-pb.ts";
import { BoxdApi, type BoxdCreate } from "../../../src/ssh/provisioner/boxd/client.ts";
import { boxdDriverFor } from "../../../src/ssh/provisioner/boxd.ts";
import { boxdApiLayer, failureCode } from "../../../src/ssh/provisioner/boxd/grpc-client.ts";

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
        "fra",
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
      assert.deepStrictEqual(calls, ["labels", "hibernate", "suspend", "destroy"]);
      const host = fakeMachine();
      const ambient = fakeBoxd();
      ambient.state.keyRefused = true;
      for (const selectedRegion of ["fra", "nyc"] as const) {
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
      HttpClient.make(() =>
        Effect.gen(function* () {
          exchanges++;
          yield* Deferred.succeed(started, undefined);
          return yield* Effect.never;
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
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(machines)).code, "UNAVAILABLE");
    }).pipe(Effect.provide(boxdApiLayer(Redacted.make("key"), "fra").pipe(Layer.provide(http))));
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
    }).pipe(
      Effect.scoped,
      Effect.provide(
        boxdApiLayer(Redacted.make("key"), "fra").pipe(
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
        boxdApiLayer(Redacted.make("key"), "fra", `http://127.0.0.1:${address.port}`).pipe(
          Layer.provide(http),
        ),
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

it.effect("routes account RPCs to boxd and machine RPCs to the selected region", () =>
  Effect.gen(function* () {
    for (const region of ["fra", "nyc"] as const) {
      const calls: Array<{ method: string; baseUrl: string }> = [];
      const transport: Parameters<typeof boxdApiLayer>[3] = ({ baseUrl }) =>
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
              return { thisRegion: region };
            },
          });
        });
      yield* Effect.gen(function* () {
        const api = yield* BoxdApi;
        yield* api.whoami;
        yield* api.orgMachineLimit;
        yield* api.regions;
      }).pipe(
        Effect.provide(
          boxdApiLayer(Redacted.make("key"), region, undefined, transport).pipe(
            Layer.provide(
              Layer.succeed(
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
              ),
            ),
          ),
        ),
      );
      assert.deepStrictEqual(calls, [
        { method: "whoami", baseUrl: "https://boxd.sh:9443" },
        { method: "getOrgMachineLimit", baseUrl: "https://boxd.sh:9443" },
        {
          method: "listRegions",
          baseUrl: region === "fra" ? "https://boxd.sh:9443" : "https://nyc.boxd.sh:9443",
        },
      ]);
    }
  }).pipe(Effect.scoped),
);
