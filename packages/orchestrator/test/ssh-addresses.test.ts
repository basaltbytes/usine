import { jsonKey } from "@usine/core/json-key";
import { assert, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { ConfigProvider, Effect, Option, Redacted, Schema } from "effect";
import { provisionerView } from "../src/operator/machines.ts";
import { sshWorkerAddressesOf } from "../src/ssh.ts";

it.effect("passes min_free_disk_gib 0 from config to the SSH executor address", () =>
  Effect.gen(function* () {
    const threshold = 0;
    const config = yield* Schema.decodeEffect(UsineConfig)({
      version: 1,
      repos: [],
      workers: [
        {
          name: "build",
          kind: "ssh",
          destination: "usine@build.example.com",
          root: "/srv/usine",
          min_free_disk_gib: threshold,
        },
      ],
    });
    const [worker] = yield* sshWorkerAddressesOf(config);
    assert.isDefined(worker);
    assert.strictEqual(worker?.minFreeDiskGib, threshold);
  }),
);

it.effect(
  "resolves boxd OAuth variables without LLM API keys and reports a missing secret by variable name",
  () =>
    Effect.gen(function* () {
      const config = yield* Schema.decodeEffect(UsineConfig)({
        version: 1,
        repos: [],
        workers: [
          {
            name: "boat",
            kind: "ssh",
            root: "/home/user/.usine",
            gateway: {
              domain: "gw.test",
              destination: "gateway",
              admin_token_env: "GATEWAY_TOKEN",
              llm_providers: ["anthropic-messages", "openai-responses"],
            },
            provisioner: {
              provider: "boxd",
              token_env: "BOAT_TOKEN",
              snapshot: "usine-attempt",
              tailnet: {
                gateway_address: "100.64.0.2",
                client_id_env: "TS_CLIENT",
                client_secret_env: "TS_SECRET",
              },
              endpoint: "https://boxd.example.com:9443",
              region: "nyc",
              isolated: false,
              egress: ["*.tailscale.com", "registry.npmjs.org"],
              // Stored before boxd ignored reuse: it loads and reaches preflight's warning.
              reuse: { attempts: 5, max_age: "2h" },
            },
          },
        ],
      });
      const resolve = (env: Record<string, string>) =>
        sshWorkerAddressesOf(config).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        );
      const env = { GATEWAY_TOKEN: "admin", BOAT_TOKEN: "boat", TS_CLIENT: "client" };
      const missing = yield* resolve(env).pipe(Effect.flip);
      assert.include(missing.message, "TS_SECRET");
      assert.strictEqual(missing.capability, "gateway");
      const [worker] = yield* resolve({ ...env, TS_SECRET: "client-secret" });
      assert(
        worker?.machine._tag === "Provisioned" && worker.machine.provisioner.provider === "boxd",
      );
      const provisioner = worker.machine.provisioner;
      assert.strictEqual(provisioner.snapshot, "usine-attempt");
      assert.deepStrictEqual(provisioner.region, Option.some("nyc"));
      assert.deepStrictEqual(provisioner.endpoint, Option.some("https://boxd.example.com:9443"));
      assert.isFalse(provisioner.isolated);
      const egress: ReadonlyArray<string> | null = Option.getOrNull(provisioner.egress);
      assert.deepStrictEqual(egress, ["*.tailscale.com", "registry.npmjs.org"]);
      assert.strictEqual(Redacted.value(provisioner.token), "boat");
      assert(Option.isSome(provisioner.ignoredReuse));
      assert.strictEqual(provisioner.ignoredReuse.value.attempts, 5);
      assert.strictEqual(provisioner.ignoredReuse.value.maxAge, "2h");
      const entry = config.workers[0];
      assert(entry?.kind === "ssh");
      const view = provisionerView(entry);
      assert(view?._tag === "boxd");
      assert.strictEqual(view.endpoint, "https://boxd.example.com:9443");
      assert.strictEqual(view.region, "nyc");
      const size: string | null = view.size;
      assert.strictEqual(size, null, "a worker without provisioner.size has no size");
      const viewed: ReadonlyArray<string> | null = view.egress;
      assert.deepStrictEqual(viewed, ["*.tailscale.com", "registry.npmjs.org"]);
      assert.deepStrictEqual(provisioner.apiKeys, {});
      assert(Option.isSome(provisioner.tailnet));
      assert.strictEqual(Redacted.value(provisioner.tailnet.value.clientSecret), "client-secret");
      const decodedValue1 = jsonKey(worker);
      assert.notInclude(decodedValue1, "client-secret");
    }),
);

it.effect("resolves a fixed tailnet worker with only the gateway admin secret", () =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeEffect(UsineConfig)({
      version: 1,
      repos: [],
      workers: [
        {
          name: "home",
          kind: "ssh",
          destination: "usine@100.64.0.3",
          root: "/home/usine/.usine",
          gateway: {
            domain: "gw.test",
            destination: "gateway",
            admin_token_env: "GATEWAY_TOKEN",
          },
          tailnet: { gateway_address: "100.64.0.2" },
        },
      ],
    });
    const [worker] = yield* sshWorkerAddressesOf(config);
    assert(worker?.machine._tag === "Fixed");
    assert(Option.isSome(worker.machine.tailnet));
    assert.strictEqual(worker.machine.tailnet.value.gatewayAddress, "100.64.0.2");
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { GATEWAY_TOKEN: "admin" } })),
    ),
  ),
);
