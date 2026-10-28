import { BoatSnapshotName } from "@usine/core/worker";
import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import {
  HetznerImage,
  HetznerLocation,
  HetznerResourceName,
  HetznerServerType,
  MachineId,
  WorkerName,
} from "@usine/core/worker";
import { Effect, Option, Redacted, Schema } from "effect";
import type { BoatProvisioner, HetznerProvisioner } from "../../../src/ssh/model.ts";
import { boatSettings, hetznerSettings } from "./support.ts";
import { boatDriverFor } from "../../../src/ssh/provisioner/boat.ts";
import { hetznerDriverFor } from "../../../src/ssh/provisioner/hetzner.ts";
import { attemptTag, type MachineTags } from "../../../src/ssh/provisioner/model.ts";
import { BOAT_TEST_API, fakeProviders, HETZNER_TEST_API } from "./fake-providers.ts";

const WORKER = WorkerName.make("hetzner-pool");
const RUN = RunId.make("0123456789abcdef0123456789abcdef");
const ATTEMPT = AttemptId.make(`${RUN}/implement/1`);

const tags: MachineTags = {
  instance: "github-app-4242",
  worker: WORKER,
  run: RUN,
  process: "a1b2c3d4e5f6",
  attempt: ATTEMPT,
};

const noWait = Effect.void;

describe("Hetzner Cloud driver", () => {
  it.effect(
    "creates a server from the snapshot in the private network, without public addresses, labeled for the instance, Worker, Run, and process",
    () => {
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const driver = yield* hetznerDriverFor(WORKER, hetznerSettings(), true, HETZNER_TEST_API);
        const { id, hostKey } = yield* driver.create("usine-hetzner-pool-0a1b2c3d", tags);
        const created = providers.calls.find(
          ({ method, path }) => method === "POST" && path === "/servers",
        );
        const { user_data: userData, ...body } = created?.body ?? {};
        assert.deepStrictEqual(body, {
          name: "usine-hetzner-pool-0a1b2c3d",
          server_type: "cx33",
          location: "nbg1",
          image: "301",
          ssh_keys: ["41"],
          networks: [7],
          firewalls: [],
          public_net: { enable_ipv4: false, enable_ipv6: false },
          labels: {
            team: "platform",
            "usine-instance": "github-app-4242",
            "usine-worker": "hetzner-pool",
            "usine-run": RUN,
            "usine-process": "a1b2c3d4e5f6",
            "usine-attempt": attemptTag(ATTEMPT),
          },
          start_after_create: true,
        });
        assert(Option.isSome(hostKey));
        assert.match(hostKey.value, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}=?$/u);
        const userDataLines = Schema.decodeUnknownSync(Schema.String)(userData).split("\n");
        assert.deepStrictEqual(userDataLines.slice(0, 5), [
          "#cloud-config",
          "ssh_deletekeys: true",
          "ssh_genkeytypes: []",
          "ssh_keys:",
          "  ed25519_private: |",
        ]);
        assert.strictEqual(userDataLines[5], "    -----BEGIN OPENSSH PRIVATE KEY-----");
        assert.include(userDataLines, "    -----END OPENSSH PRIVATE KEY-----");
        assert.include(userDataLines, `  ed25519_public: ${hostKey.value}`);
        providers.hetzner.startingReads = 2;
        const endpoint = yield* driver.endpoint(id, noWait);
        assert.strictEqual(endpoint.destination, "usine@10.42.0.5");
        assert.isTrue(Option.isNone(endpoint.hostKey));
        assert.isTrue(Option.isNone(endpoint.port));

        const [listed] = yield* driver.list("github-app-4242", Option.some(WORKER));
        assert.strictEqual(listed?.id, id);
        assert.deepStrictEqual(listed?.tags.attempt, Option.some(attemptTag(ATTEMPT)));
        assert.strictEqual(listed?.tags.process, "a1b2c3d4e5f6");
        const listing = [...providers.calls]
          .reverse()
          .find(({ method, path }) => method === "GET" && path === "/servers");
        assert.strictEqual(
          listing?.query.label_selector,
          "usine-instance=github-app-4242,usine-worker=hetzner-pool",
        );
        assert.lengthOf(
          yield* driver.list("github-app-4242", Option.some(WorkerName.make("other"))),
          0,
        );

        yield* driver.remove(id);
        assert.strictEqual(providers.hetzner.servers.size, 0);
        // A server that is already gone counts as deleted.
        yield* driver.remove(id);
      }).pipe(Effect.provide(providers.layer));
    },
  );

  it.effect(
    "gives a server without a Gateway a public IPv4 address to connect to, behind the project's firewall",
    () => {
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const driver = yield* hetznerDriverFor(
          WORKER,
          hetznerSettings({
            firewall: Option.some(HetznerResourceName.make("usine-orchestrator-ssh")),
          }),
          false,
          HETZNER_TEST_API,
        );
        const { id } = yield* driver.create("usine-hetzner-pool-1", tags);
        const created = providers.calls.find(({ method }) => method === "POST");
        assert.deepInclude(created?.body ?? {}, {
          firewalls: [{ firewall: 81 }],
          public_net: { enable_ipv4: true, enable_ipv6: false },
        });
        const endpoint = yield* driver.endpoint(id, noWait);
        assert.match(endpoint.destination, /^usine@203\.0\.113\.\d+$/u);
        const missing = yield* driver.verify(WORKER, 1).pipe(Effect.as("verified"));
        assert.strictEqual(missing, "verified");
        const unknown = yield* hetznerDriverFor(
          WORKER,
          hetznerSettings({ firewall: Option.some(HetznerResourceName.make("open")) }),
          false,
          HETZNER_TEST_API,
        ).pipe(
          Effect.flatMap((other) => other.verify(WORKER, 1)),
          Effect.flip,
        );
        assert.include(unknown.message, 'no firewall named "open"');
      }).pipe(Effect.provide(providers.layer));
    },
  );

  it.effect(
    "turns quota, out-of-stock plans, API errors, and no response into retryable creation failures",
    () => {
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const driver = yield* hetznerDriverFor(WORKER, hetznerSettings(), true, HETZNER_TEST_API);
        const reasonOf = Effect.fnUntraced(function* () {
          const failure = yield* driver.create("usine-x", tags).pipe(Effect.flip);
          return { reason: failure.reason, message: failure.message };
        });
        providers.hetzner.createFails = {
          status: 403,
          code: "resource_limit_exceeded",
          message: "project limit exceeded",
        };
        const quota = yield* reasonOf();
        assert.strictEqual(quota.reason, "quota");
        assert.include(quota.message, "project limit exceeded");
        providers.hetzner.createFails = {
          status: 412,
          code: "resource_unavailable",
          message: "This product is currently unavailable",
        };
        assert.strictEqual((yield* reasonOf()).reason, "capacity");
        providers.hetzner.createFails = { status: 500, code: "server_error", message: "boom" };
        assert.strictEqual((yield* reasonOf()).reason, "provider");
        providers.hetzner.createFails = undefined;
        providers.hetzner.unreachable = true;
        assert.strictEqual((yield* reasonOf()).reason, "unreachable");
        assert.strictEqual(providers.hetzner.servers.size, 0);
      }).pipe(Effect.provide(providers.layer));
    },
  );

  it.effect(
    "checks the token, server type, location, snapshot, SSH key, and network, and warns about an out-of-stock type",
    () => {
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const verify = (settings: HetznerProvisioner) =>
          hetznerDriverFor(WORKER, settings, true, HETZNER_TEST_API).pipe(
            Effect.flatMap((driver) => driver.verify(WORKER, 4)),
          );
        assert.deepStrictEqual((yield* verify(hetznerSettings())).warnings, []);
        const outOfStock = yield* verify(
          hetznerSettings({ location: HetznerLocation.make("fsn1") }),
        );
        assert.lengthOf(outOfStock.warnings, 1);
        assert.include(outOfStock.warnings[0] ?? "", "no cx33 available in fsn1");

        const refused = (settings: HetznerProvisioner) => verify(settings).pipe(Effect.flip);
        const token = yield* refused(hetznerSettings({ token: Redacted.make("wrong") }));
        assert.strictEqual(token.capability, "provider");
        assert.include(token.message, "refused the token");
        assert.include(
          (yield* refused(hetznerSettings({ serverType: HetznerServerType.make("cx99") }))).message,
          'no server type "cx99"',
        );
        assert.include(
          (yield* refused(hetznerSettings({ location: HetznerLocation.make("hel1") }))).message,
          "doesn't offer server type cx33 in hel1",
        );
        assert.include(
          (yield* refused(hetznerSettings({ image: HetznerImage.make("missing-snapshot") })))
            .message,
          "snapshot.sh",
        );
        assert.include(
          (yield* refused(hetznerSettings({ sshKey: HetznerResourceName.make("nobody") }))).message,
          'no SSH key named "nobody"',
        );
        assert.include(
          (yield* refused(
            hetznerSettings({ network: Option.some(HetznerResourceName.make("lan")) }),
          )).message,
          'no network named "lan"',
        );
        // A numeric image is read by ID.
        yield* verify(hetznerSettings({ image: HetznerImage.make("301") }));
      }).pipe(Effect.provide(providers.layer));
    },
  );
});

describe("Boat driver", () => {
  it.effect(
    "creates a sandbox with none of the account's secrets, no snapshots, no monitoring, and no auto-stop, and pins the host key it reports",
    () => {
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const driver = yield* boatDriverFor(
          WORKER,
          boatSettings(),
          "ssh-ed25519 AAAAOperatorKey usine",
          BOAT_TEST_API,
        );
        const { id, hostKey } = yield* driver.create("ignored", tags);
        assert.isTrue(Option.isNone(hostKey));
        const created = providers.boat.sandboxes.get(id);
        assert.deepStrictEqual(created?.body, {
          type: "default",
          name: `usine github-app-4242 hetzner-pool ${RUN} a1b2c3d4e5f6 ${attemptTag(ATTEMPT)}`,
          ttlSeconds: null,
          noEnv: true,
          snapshots: false,
          monitoring: false,
          failFast: true,
        });
        assert(created !== undefined);
        created.provisioningReads = 2;
        const endpoint = yield* driver.endpoint(id, noWait);
        assert.strictEqual(endpoint.destination, "user@198.51.100.20");
        assert.deepStrictEqual(endpoint.hostKey, Option.some(providers.boat.hostKey));
        const key = providers.calls.find(({ path }) => path === `/sandboxes/${id}/sshkey`);
        assert.deepStrictEqual(key?.body, { key: "ssh-ed25519 AAAAOperatorKey usine" });

        assert.strictEqual(
          providers.boat.sandboxes.get(id)?.name,
          `usine github-app-4242 hetzner-pool ${RUN} a1b2c3d4e5f6 ${attemptTag(ATTEMPT)}`,
        );
        yield* driver.remove(id);
        assert.strictEqual(providers.boat.sandboxes.size, 0);
        const deletion = [...providers.calls].reverse().find(({ method }) => method === "DELETE");
        assert.strictEqual(deletion?.headers["x-ascii-confirm-delete"], id);
        yield* driver.remove(MachineId.make(id));
      }).pipe(Effect.provide(providers.layer));
    },
  );

  it.effect(
    "connects through Boat's SSH forward when the machine has no IPv4 address of its own",
    () => {
      const providers = fakeProviders();
      providers.boat.sshEndpoint = "203.0.113.10:22001";
      return Effect.gen(function* () {
        const driver = yield* boatDriverFor(
          WORKER,
          boatSettings(),
          "ssh-ed25519 AAAA",
          BOAT_TEST_API,
        );
        const endpoint = yield* driver.endpoint((yield* driver.create("x", tags)).id, noWait);
        assert.strictEqual(endpoint.destination, "user@203.0.113.10");
        assert.deepStrictEqual(endpoint.port, Option.some(22001));
      }).pipe(Effect.provide(providers.layer));
    },
  );

  it.effect("lists only this instance's and Worker's sandboxes, across pages", () => {
    const providers = fakeProviders();
    providers.boat.pageSize = 1;
    return Effect.gen(function* () {
      const driver = yield* boatDriverFor(
        WORKER,
        boatSettings(),
        "ssh-ed25519 AAAA",
        BOAT_TEST_API,
      );
      const { id: ours } = yield* driver.create("x", tags);
      yield* driver.create("x", { ...tags, worker: WorkerName.make("other") });
      yield* driver.create("x", { ...tags, instance: "github-app-1" });
      const listed = yield* driver.list("github-app-4242", Option.some(WORKER));
      assert.deepStrictEqual(
        listed.map(({ id }) => id),
        [ours],
      );
      assert.lengthOf(yield* driver.list("github-app-4242", Option.none()), 2);
      assert.strictEqual(listed[0]?.tags.run, RUN);
      assert.deepStrictEqual(listed[0]?.tags.attempt, Option.some(attemptTag(ATTEMPT)));
    }).pipe(Effect.provide(providers.layer));
  });

  it.effect("turns no ready machine and plan limits into retryable creation failures", () => {
    const providers = fakeProviders();
    return Effect.gen(function* () {
      const driver = yield* boatDriverFor(
        WORKER,
        boatSettings(),
        "ssh-ed25519 AAAA",
        BOAT_TEST_API,
      );
      providers.boat.createFails = {
        status: 503,
        code: "no_ready_machine",
        message: "No ready machine of this type",
      };
      assert.strictEqual((yield* driver.create("x", tags).pipe(Effect.flip)).reason, "capacity");
      providers.boat.createFails = { status: 429, code: "limit_reached", message: "limit reached" };
      assert.strictEqual((yield* driver.create("x", tags).pipe(Effect.flip)).reason, "quota");
      providers.boat.createFails = { status: 402, code: "payment_required", message: "Pay" };
      assert.strictEqual((yield* driver.create("x", tags).pipe(Effect.flip)).reason, "quota");
    }).pipe(Effect.provide(providers.layer));
  });

  it.effect(
    "creates from a ready snapshot without account credentials and refuses missing or unfinished snapshots",
    () => {
      const providers = fakeProviders();
      return Effect.gen(function* () {
        const driver = yield* boatDriverFor(
          WORKER,
          boatSettings({ snapshot: Option.some(BoatSnapshotName.make("usine-attempt")) }),
          "ssh-ed25519 AAAA",
          BOAT_TEST_API,
        );
        yield* driver.verify(WORKER, 1);
        const { id } = yield* driver.create("unique-create", tags);
        assert.strictEqual(providers.boat.sandboxes.get(id)?.body?.from, "usine-attempt");
        assert.strictEqual(providers.boat.sandboxes.get(id)?.body?.noEnv, true);
        assert.strictEqual(
          providers.calls.find((call) => call.method === "POST" && call.path === "/sandboxes")
            ?.headers["idempotency-key"],
          "unique-create",
        );
        for (const state of ["saving", "failed"]) {
          providers.boat.snapshots.set("usine-attempt", state);
          assert.include((yield* driver.verify(WORKER, 1).pipe(Effect.flip)).message, state);
        }
        providers.boat.snapshots.clear();
        assert.include((yield* driver.verify(WORKER, 1).pipe(Effect.flip)).message, "404");
      }).pipe(Effect.provide(providers.layer));
    },
  );

  it.effect("checks the API key and the account's limits and machine sizes", () => {
    const providers = fakeProviders();
    return Effect.gen(function* () {
      const verify = (settings: BoatProvisioner, maxConcurrentAttempts = 2) =>
        boatDriverFor(WORKER, settings, "ssh-ed25519 AAAA", BOAT_TEST_API).pipe(
          Effect.flatMap((driver) => driver.verify(WORKER, maxConcurrentAttempts)),
        );
      assert.deepStrictEqual((yield* verify(boatSettings())).warnings, []);
      providers.boat.limits = { ...providers.boat.limits, maxActiveSandboxes: 1, canStart: false };
      assert.lengthOf((yield* verify(boatSettings())).warnings, 2);
      const size = yield* verify(boatSettings({ size: "xlarge" })).pipe(Effect.flip);
      assert.strictEqual(size.capability, "provider");
      assert.include(size.message, "needs the $100/month plan");
      const token = yield* verify(boatSettings({ token: Redacted.make("boat_wrong") })).pipe(
        Effect.flip,
      );
      assert.include(token.message, "refused the API key");
    }).pipe(Effect.provide(providers.layer));
  });
});
