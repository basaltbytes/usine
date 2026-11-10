import { assert, describe, it } from "@effect/vitest";
import { AttemptId } from "@usine/core/attempt";
import { RunId } from "@usine/core/run";
import {
  BoatSnapshotName,
  BoxdEgressEntry,
  HetznerImage,
  HetznerLocation,
  HetznerResourceName,
  HetznerServerType,
  MachineId,
  TailnetAddress,
  WorkerName,
} from "@usine/core/worker";
import { Clock, Effect, Fiber, Option, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { BoatProvisioner, HetznerProvisioner } from "../../../src/ssh/model.ts";
import { boatSettings, boxdSettings, hetznerSettings } from "./support.ts";
import { fakeBoxd } from "./fake-boxd.ts";
import { boxdDriverFor } from "../../../src/ssh/provisioner/boxd.ts";
import { boatDriverFor } from "../../../src/ssh/provisioner/boat.ts";
import { hetznerDriverFor } from "../../../src/ssh/provisioner/hetzner.ts";
import { tagValue, attemptTag, type MachineTags } from "../../../src/ssh/provisioner/model.ts";
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
  attempts: 1,
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
            "usine-attempts": "1",
          },
          start_after_create: true,
        });
        assert(Option.isSome(hostKey));
        assert.match(hostKey.value, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}=?$/u);
        const decodedValue1 = yield* Schema.decodeUnknownEffect(Schema.String)(userData);
        const userDataLines = decodedValue1.split("\n");
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
        const entries = yield* driver.list(
          "github-app-4242",
          Option.some(WorkerName.make("other")),
        );
        assert.lengthOf(entries, 0);

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
        const decodedValue6 = yield* refused(
          hetznerSettings({ serverType: HetznerServerType.make("cx99") }),
        );
        assert.include(decodedValue6.message, 'no server type "cx99"');
        const decodedValue7 = yield* refused(
          hetznerSettings({ location: HetznerLocation.make("hel1") }),
        );
        assert.include(decodedValue7.message, "doesn't offer server type cx33 in hel1");
        const decodedValue8 = yield* refused(
          hetznerSettings({ image: HetznerImage.make("missing-snapshot") }),
        );
        assert.include(decodedValue8.message, "snapshot.sh");
        const decodedValue9 = yield* refused(
          hetznerSettings({ sshKey: HetznerResourceName.make("nobody") }),
        );
        assert.include(decodedValue9.message, 'no SSH key named "nobody"');

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
          name: `usine github-app-4242 hetzner-pool ${tagValue(RUN, 24)} a1b2c3d4e5f6 ${attemptTag(ATTEMPT)} 1`,
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
          `usine github-app-4242 hetzner-pool ${tagValue(RUN, 24)} a1b2c3d4e5f6 ${attemptTag(ATTEMPT)} 1`,
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
      const entries = yield* driver.list("github-app-4242", Option.none());
      assert.lengthOf(entries, 2);
      assert.strictEqual(listed[0]?.tags.run, tagValue(RUN, 24));
      assert.strictEqual(listed[0]?.attempts, 1);
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

describe("boxd driver", () => {
  it.effect(
    "restores without sizing overrides, labels the machine, disables idle timers, and caches the proxy host key",
    () => {
      const boxd = fakeBoxd();
      return Effect.gen(function* () {
        const driver = yield* boxdDriverFor(WORKER, boxdSettings());
        const first = yield* driver.create("pool-aaaaaaaa", tags);
        assert.isTrue(Option.isNone(first.hostKey));
        assert.deepStrictEqual(boxd.state.creates[0], {
          snapshot: "usine-attempt",
          name: "pool-aaaaaaaa",
          isolated: true,
          config: { network: { ssh: true } },
          labels: {
            "usine.instance": tags.instance,
            "usine.worker": WORKER,
            "usine.run": RUN,
            "usine.process": tags.process,
            "usine.attempt": attemptTag(ATTEMPT),
            "usine.attempts": "1",
          },
        });
        assert.deepStrictEqual(
          boxd.state.timers.map(({ seconds }) => seconds),
          [0, 0],
        );
        const second = yield* driver.create("pool-bbbbbbbb", { ...tags, attempts: 2 });
        const [endpoint] = yield* Effect.all(
          [driver.endpoint(first.id, Effect.void), driver.endpoint(second.id, Effect.void)],
          { concurrency: 2 },
        );
        assert.strictEqual(endpoint.destination, "boxd@198.51.100.40");
        assert.deepStrictEqual(endpoint.port, Option.some(12001));
        assert.deepStrictEqual(endpoint.hostKey, Option.some(boxd.state.hostKey));
        assert.strictEqual(boxd.state.reads, 0, "the create response contains the endpoint");
        yield* Effect.all(
          [driver.endpoint(second.id, Effect.void), driver.endpoint(first.id, Effect.void)],
          { concurrency: 2 },
        );
        assert.strictEqual(boxd.state.hostKeyReads, 1);
        boxd.state.timers.length = 0;
        yield* driver.assign(first.id, { ...tags, attempts: 2 });
        assert.deepStrictEqual(boxd.state.timers, [
          { id: first.id, kind: "hibernate", seconds: 0 },
          { id: first.id, kind: "suspend", seconds: 0 },
        ]);
        assert.strictEqual(boxd.state.machines.get(first.id)?.labels["usine.attempts"], "2");
        yield* driver.remove(first.id);
        yield* driver.remove(first.id);
      }).pipe(Effect.provide(boxd.layer));
    },
  );
  it.effect("preserves unique names across instances and the disabled isolation setting", () => {
    const boxd = fakeBoxd();
    return Effect.gen(function* () {
      const driver = yield* boxdDriverFor(WORKER, boxdSettings({ isolated: false }));
      const first = yield* driver.create("pool-aaaaaaaa", { ...tags, instance: "factory" });
      const second = yield* driver.create("pool-bbbbbbbb", { ...tags, instance: "dev" });
      assert.notStrictEqual(first.id, second.id);
      assert.deepStrictEqual(
        boxd.state.creates.map(({ name, isolated }) => ({ name, isolated })),
        [
          { name: "pool-aaaaaaaa", isolated: false },
          { name: "pool-bbbbbbbb", isolated: false },
        ],
      );
      const duplicate = yield* driver.create("pool-aaaaaaaa", tags).pipe(Effect.flip);
      assert.strictEqual(duplicate.reason, "provider");
      assert.include(duplicate.message, "ALREADY_EXISTS");
    }).pipe(Effect.provide(boxd.layer));
  });
  it.effect(
    "polls until running, refreshes proxy ports, and reports terminal machines as gone",
    () => {
      const boxd = fakeBoxd();
      boxd.state.createMachine = false;
      boxd.state.provisioningReads = 2;
      return Effect.gen(function* () {
        const driver = yield* boxdDriverFor(WORKER, boxdSettings());
        const { id } = yield* driver.create("ignored", tags);
        yield* driver.endpoint(id, Effect.void);
        assert.strictEqual(boxd.state.reads, 3);
        const machine = boxd.state.machines.get(id);
        assert(machine !== undefined);
        boxd.state.machines.set(id, { ...machine, status: "running", sshPort: 24001 });
        assert.deepStrictEqual(
          (yield* driver.refreshEndpoint(id)).pipe(Option.map((value) => value.port)),
          Option.some(Option.some(24001)),
        );
        boxd.state.machines.set(id, { ...machine, sshDisabled: true });
        const disabled = yield* driver
          .endpoint(id, Effect.die("must not poll disabled SSH"))
          .pipe(Effect.flip);
        assert.strictEqual(disabled.reason, "provider");
        assert.include(disabled.message, "SSH disabled");
        for (const status of ["stopped", "failed", "destroyed"]) {
          boxd.state.machines.set(id, { ...machine, status });
          const terminal = yield* driver
            .endpoint(id, Effect.die("must not poll terminal machines"))
            .pipe(Effect.flip);
          assert.strictEqual(terminal.reason, "capacity");
          assert.include(terminal.message, status);
          const gone = yield* driver.refreshEndpoint(id);
          assert.isTrue(Option.isNone(gone));
        }
        for (const status of ["suspended", "hibernated", "migrating", "pending"]) {
          boxd.state.machines.set(id, { ...machine, status });
          assert.strictEqual(
            (yield* driver.refreshEndpoint(id).pipe(Effect.flip))._tag,
            "ProviderApiError",
          );
          let polls = 0;
          const endpoint = yield* driver.endpoint(
            id,
            Effect.sync(() => {
              polls++;
              boxd.state.machines.set(id, { ...machine, status: "running" });
            }),
          );
          assert.strictEqual(polls, 1, `waits for ${status} machines to resume`);
          assert.strictEqual(endpoint.destination, "boxd@198.51.100.40");
        }
        boxd.state.machines.delete(id);
        const gone = yield* driver.refreshEndpoint(id);
        assert.isTrue(Option.isNone(gone));
        assert.strictEqual(
          (yield* driver.endpoint(id, Effect.void).pipe(Effect.flip)).reason,
          "capacity",
        );
      }).pipe(Effect.provide(boxd.layer));
    },
  );
  it.effect("keeps refresh read and proxy host-key failures as provider errors", () => {
    const boxd = fakeBoxd();
    return Effect.gen(function* () {
      const driver = yield* boxdDriverFor(WORKER, boxdSettings());
      const { id } = yield* driver.create("pool-aaaaaaaa", tags);
      for (const code of ["UNAVAILABLE", "DEADLINE_EXCEEDED", "UNAUTHENTICATED"]) {
        boxd.state.readFails = Option.some(code);
        const failure = yield* driver.refreshEndpoint(id).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ProviderApiError");
        assert.include(failure.message, code);
        assert.isTrue(boxd.state.machines.has(id));
      }
      boxd.state.readFails = Option.none();
      const hostKey = boxd.state.hostKey;
      boxd.state.hostKey = "";
      const failure = yield* driver.refreshEndpoint(id).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ProviderApiError");
      assert.include(failure.message, "sshHostKey: INTERNAL");
      assert.strictEqual(boxd.state.hostKeyReads, 1);
      assert.isTrue(boxd.state.machines.has(id));
      boxd.state.hostKey = hostKey;
      const recovered = yield* driver.refreshEndpoint(id);
      assert(Option.isSome(recovered));
      assert.deepStrictEqual(recovered.value.hostKey, Option.some(hostKey));
    }).pipe(Effect.provide(boxd.layer));
  });
  it.effect(
    "lists machines by instance and worker selectors, including creation time and attempt count",
    () => {
      const boxd = fakeBoxd();
      return Effect.gen(function* () {
        const driver = yield* boxdDriverFor(WORKER, boxdSettings());
        const { id } = yield* driver.create("x", tags);
        yield* driver.create("y", { ...tags, worker: WorkerName.make("other") });
        yield* driver.create("z", { ...tags, instance: "another" });
        const listed = yield* driver.list(tags.instance, Option.some(WORKER));
        assert.deepStrictEqual(
          listed.map((machine) => machine.id),
          [id],
        );
        assert.strictEqual(listed[0]?.attempts, 1);
        assert.deepStrictEqual(boxd.state.selectors[0], [
          `usine.instance=${tags.instance}`,
          `usine.worker=${WORKER}`,
        ]);
        const all = yield* driver.list(tags.instance, Option.none());
        assert.lengthOf(all, 2);
      }).pipe(Effect.provide(boxd.layer));
    },
  );
  it.live(
    "restricts a new machine's egress before anything else, reapplies it on reuse, and leaves an unset setting alone",
    () => {
      const boxd = fakeBoxd();
      const entries = ["*.tailscale.com", "registry.npmjs.org"].map((entry) =>
        BoxdEgressEntry.make(entry),
      );
      return Effect.gen(function* () {
        const driver = yield* boxdDriverFor(WORKER, boxdSettings({ egress: Option.some(entries) }));
        const started = yield* Clock.currentTimeMillis;
        const { id } = yield* driver.create("pool-aaaaaaaa", tags);
        const returned = yield* Clock.currentTimeMillis;
        assert.isAtLeast(returned - started, 1000, "waits until boxd enforces the allowlist");
        assert.deepStrictEqual(boxd.state.operations.get(id), [
          "create",
          "egress",
          "hibernate",
          "suspend",
        ]);
        assert.deepStrictEqual(boxd.state.machines.get(id)?.egressAllow, entries);
        yield* driver.assign(id, { ...tags, attempts: 2 });
        assert.deepStrictEqual(
          boxd.state.egress.map((call) => call.entries),
          [entries, entries],
        );

        const unrestricted = yield* boxdDriverFor(WORKER, boxdSettings());
        const other = yield* unrestricted.create("pool-bbbbbbbb", tags);
        assert.deepStrictEqual(boxd.state.operations.get(other.id), [
          "create",
          "hibernate",
          "suspend",
        ]);
        yield* unrestricted.assign(other.id, { ...tags, attempts: 2 });
        assert.lengthOf(boxd.state.egress, 2, "an unset egress leaves the machine's list as is");
        assert.deepStrictEqual(boxd.state.operations.get(other.id), [
          "create",
          "hibernate",
          "suspend",
          "hibernate",
          "suspend",
        ]);
      }).pipe(Effect.provide(boxd.layer));
    },
  );
  it.effect(
    "deletes a new machine when its creation is interrupted while egress comes into force",
    () => {
      const boxd = fakeBoxd();
      const egress = Option.some([BoxdEgressEntry.make("*.tailscale.com")]);
      return Effect.gen(function* () {
        const driver = yield* boxdDriverFor(WORKER, boxdSettings({ egress }));
        const creating = yield* Effect.forkChild(driver.create("pool-aaaaaaaa", tags));
        while (boxd.state.timers.length < 2) yield* Effect.yieldNow;
        yield* TestClock.adjust("500 millis");
        assert.strictEqual(boxd.state.machines.size, 1, "the machine waits for its allowlist");
        yield* Fiber.interrupt(creating);
        assert.strictEqual(boxd.state.machines.size, 0);
      }).pipe(Effect.provide(boxd.layer));
    },
  );
  it.effect("warns at preflight about address entries behind a gateway", () => {
    const boxd = fakeBoxd();
    const egress = Option.some(
      ["*.tailscale.com", "registry.npmjs.org", "203.0.113.7", "198.51.100.0/24"].map((entry) =>
        BoxdEgressEntry.make(entry),
      ),
    );
    return Effect.gen(function* () {
      const direct = yield* boxdDriverFor(WORKER, boxdSettings({ egress }));
      assert.deepStrictEqual((yield* direct.verify(WORKER, 1)).warnings, []);
      const gateway = yield* boxdDriverFor(
        WORKER,
        boxdSettings({
          egress,
          tailnet: Option.some({
            gatewayAddress: TailnetAddress.make("100.64.0.2"),
            clientId: Redacted.make("test-client"),
            clientSecret: Redacted.make("test-client-secret"),
          }),
        }),
      );
      const { warnings } = yield* gateway.verify(WORKER, 1);
      assert.lengthOf(warnings, 1);
      assert.include(warnings[0], "admits the addresses 203.0.113.7, 198.51.100.0/24");
    }).pipe(Effect.provide(boxd.layer));
  });
  it.effect("deletes a new machine whose egress allowlist boxd refuses or ignores", () => {
    const boxd = fakeBoxd();
    const egress = Option.some([BoxdEgressEntry.make("*.tailscale.com")]);
    return Effect.gen(function* () {
      const driver = yield* boxdDriverFor(WORKER, boxdSettings({ egress }));
      boxd.state.egressFails = Option.some("INVALID_ARGUMENT");
      const refused = yield* driver.create("pool-aaaaaaaa", tags).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "refused");
      assert.include(refused.message, "didn't apply provisioner.egress");
      assert.strictEqual(boxd.state.machines.size, 0);
      boxd.state.egressFails = Option.none();
      boxd.state.egressIgnored = true;
      const ignored = yield* driver.create("pool-bbbbbbbb", tags).pipe(Effect.flip);
      assert.strictEqual(ignored.reason, "provider");
      assert.include(ignored.message, "unrestricted egress");
      assert.strictEqual(boxd.state.machines.size, 0);
      assert.lengthOf(boxd.state.timers, 0);
    }).pipe(Effect.provide(boxd.layer));
  });
  it.effect("refuses to reuse a machine whose egress allowlist boxd ignores or refuses", () => {
    const boxd = fakeBoxd();
    const egress = Option.some([BoxdEgressEntry.make("*.tailscale.com")]);
    return Effect.gen(function* () {
      const driver = yield* boxdDriverFor(WORKER, boxdSettings({ egress }));
      const creating = yield* Effect.forkChild(driver.create("pool-aaaaaaaa", tags));
      while (boxd.state.timers.length < 2) yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      const { id } = yield* Fiber.join(creating);
      const created = ["create", "egress", "hibernate", "suspend"];
      assert.deepStrictEqual(boxd.state.operations.get(id), created);

      boxd.state.egressIgnored = true;
      const ignored = yield* driver.assign(id, { ...tags, attempts: 2 }).pipe(Effect.flip);
      assert.strictEqual(ignored._tag, "ProviderApiError");
      assert.include(ignored.message, "unrestricted egress");
      assert.include(ignored.message, id);
      assert.deepStrictEqual(
        boxd.state.operations.get(id),
        [...created, "egress"],
        "no idle timer call follows the ignored allowlist",
      );

      boxd.state.egressIgnored = false;
      boxd.state.egressFails = Option.some("INVALID_ARGUMENT");
      const refused = yield* driver.assign(id, { ...tags, attempts: 3 }).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "ProviderApiError");
      assert.include(refused.message, "INVALID_ARGUMENT");
      assert.deepStrictEqual(
        boxd.state.operations.get(id),
        [...created, "egress"],
        "no idle timer call follows the refused allowlist",
      );
      assert.lengthOf(boxd.state.timers, 2);
    }).pipe(Effect.provide(boxd.layer));
  });
  it.effect("deletes a new machine when disabling its idle timers fails", () => {
    const boxd = fakeBoxd();
    boxd.state.timerFails = Option.some("UNAVAILABLE");
    return Effect.gen(function* () {
      const driver = yield* boxdDriverFor(WORKER, boxdSettings());
      const failure = yield* driver.create("ignored", tags).pipe(Effect.flip);
      assert.strictEqual(failure.reason, "unreachable");
      assert.strictEqual(boxd.state.machines.size, 0);
    }).pipe(Effect.provide(boxd.layer));
  });
  it.effect("classifies gRPC creation failures and pending snapshots for retry", () => {
    const boxd = fakeBoxd();
    return Effect.gen(function* () {
      const driver = yield* boxdDriverFor(WORKER, boxdSettings());
      for (const [code, reason] of [
        ["RESOURCE_EXHAUSTED", "quota"],
        ["UNAVAILABLE", "unreachable"],
        ["DEADLINE_EXCEEDED", "unreachable"],
        ["UNAUTHENTICATED", "refused"],
        ["PERMISSION_DENIED", "refused"],
        ["INVALID_ARGUMENT", "refused"],
        ["INTERNAL", "provider"],
        ["ABORTED", "provider"],
      ]) {
        boxd.state.createFails = Option.some(code ?? "UNKNOWN");
        assert.strictEqual((yield* driver.create("x", tags).pipe(Effect.flip)).reason, reason);
      }
      boxd.state.createFails = Option.none();
      boxd.state.snapshot.status = "pending";
      assert.strictEqual((yield* driver.create("x", tags).pipe(Effect.flip)).reason, "provider");
    }).pipe(Effect.provide(boxd.layer));
  });
  it.effect(
    "verifies identity, snapshot status, region and captured size, and warns about machine limits",
    () => {
      const boxd = fakeBoxd();
      return Effect.gen(function* () {
        const driver = yield* boxdDriverFor(WORKER, boxdSettings());
        assert.deepStrictEqual((yield* driver.verify(WORKER, 2)).warnings, []);
        boxd.state.maxVms = 2;
        boxd.state.vmCount = 0;
        assert.deepStrictEqual((yield* driver.verify(WORKER, 2)).warnings, []);
        boxd.state.vmCount = 1;
        assert.lengthOf((yield* driver.verify(WORKER, 2)).warnings, 1);
        boxd.state.keyRefused = true;
        assert.include(
          (yield* driver.verify(WORKER, 1).pipe(Effect.flip)).message,
          "boxd auth keys create",
        );
        boxd.state.keyRefused = false;
        boxd.state.snapshot.status = "pending";
        assert.include((yield* driver.verify(WORKER, 1).pipe(Effect.flip)).message, "pending");
        boxd.state.snapshot.status = "ready";
        boxd.state.snapshot.vcpu = 4;
        boxd.state.snapshot.memoryBytes = 16 * 1024 ** 3;
        const mismatch = yield* driver.verify(WORKER, 1).pipe(Effect.flip);
        assert.include(mismatch.message, "4 vCPU and 16 GiB");
        assert.include(mismatch.message, "Rebuild the snapshot at 2x8 or change size");
        boxd.state.snapshot.vcpu = 2;
        const memoryMismatch = yield* driver.verify(WORKER, 1).pipe(Effect.flip);
        assert.include(memoryMismatch.message, "2 vCPU and 16 GiB");
        boxd.state.snapshot.memoryBytes = 8 * 1024 ** 3;
        boxd.state.snapshot.region = "nyc";
        assert.include((yield* driver.verify(WORKER, 1).pipe(Effect.flip)).message, "is in nyc");
        boxd.state.snapshot.region = "fra";
        boxd.state.region = "nyc";
        assert.include(
          (yield* driver.verify(WORKER, 1).pipe(Effect.flip)).message,
          "endpoint serves nyc",
        );
      }).pipe(Effect.provide(boxd.layer));
    },
  );
});
