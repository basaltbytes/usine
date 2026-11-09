import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { assert, it } from "@effect/vitest";
import { MachineId } from "@usine/core/worker";
import { Clock, Effect, Layer, Predicate, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createServer } from "node:http2";
import { jsonKey } from "@usine/core/json-key";
import { BoxdApi as BoxdService } from "../../../src/ssh/provisioner/boxd/api-pb.ts";
import { BoxdApi, type BoxdCreate } from "../../../src/ssh/provisioner/boxd/client.ts";
import { boxdApiLayer } from "../../../src/ssh/provisioner/boxd/grpc-client.ts";

it.live(
  "decodes real gRPC responses, shares authentication, retains proxy metadata, and sanitizes refusals",
  () =>
    Effect.gen(function* () {
      const key = "bxd_test_transport_key";
      const jwt = "test-jwt";
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
      let hostKey = "ssh-ed25519 AAAAProxyKey";
      const server = createServer(
        connectNodeAdapter({
          routes: (router) =>
            router.service(BoxdService, {
              whoami: (_request, context) => {
                assert.strictEqual(context.requestHeader.get("authorization"), `Bearer ${jwt}`);
                return { userId: "member" };
              },
              getOrgMachineLimit: () => ({ maxVms: 50, vmCount: 2 }),
              getSnapshot: () => ({
                snapshot: {
                  status: "ready",
                  region: "fra",
                  vcpu: 2,
                  memoryBytes: 8n * 1024n ** 3n,
                },
              }),
              listRegions: () => ({ thisRegion: "fra" }),
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
            assert.strictEqual(request.url, "https://app.boxd.sh/api/v1/auth/token");
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
        hostKey = "";
        const missingKey = yield* api.sshHostKey.pipe(Effect.flip);
        assert.strictEqual(missingKey.code, "INTERNAL");
      }).pipe(Effect.provide(layer));
      assert.strictEqual(exchanges, 1);
      assert.deepStrictEqual(selectors[0], ["usine.worker=worker"]);
      assert.deepStrictEqual(calls, ["labels", "hibernate", "suspend", "destroy"]);
    }).pipe(Effect.scoped),
);
