import { jsonKey } from "@usine/core/json-key";
import { assert, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { ConfigProvider, Effect, Option, Redacted, Schema } from "effect";
import { sshWorkerAddressesOf } from "../src/ssh.ts";

for (const provider of ["boat", "boxd"] as const) {
  it.effect(
    `resolves ${provider} OAuth variables without LLM API keys and reports a missing secret by variable name`,
    () =>
      Effect.gen(function* () {
        const yamlProvisioner = {
          provider,
          token_env: "BOAT_TOKEN",
          snapshot: "usine-attempt",
          tailnet: {
            gateway_address: "100.64.0.2",
            client_id_env: "TS_CLIENT",
            client_secret_env: "TS_SECRET",
          },
        };
        const config = yield* Schema.decodeEffect(UsineConfig)({
          version: 1,
          repos: [],
          workers: [
            {
              name: "boat",
              kind: "ssh",
              root: "/home/user/.usine",
              identity_file: "/keys/boat",
              gateway: {
                domain: "gw.test",
                destination: "gateway",
                admin_token_env: "GATEWAY_TOKEN",
                llm_providers: ["anthropic-messages", "openai-responses"],
              },
              provisioner:
                provider === "boxd"
                  ? { ...yamlProvisioner, region: "nyc", isolated: false }
                  : yamlProvisioner,
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
          worker?.machine._tag === "Provisioned" &&
            worker.machine.provisioner.provider === provider,
        );
        const provisioner = worker.machine.provisioner;
        assert.deepStrictEqual(
          provisioner.provider === "boxd"
            ? Option.some(provisioner.snapshot)
            : provisioner.snapshot,
          Option.some("usine-attempt"),
        );
        if (provisioner.provider === "boxd") {
          assert.strictEqual(provisioner.region, "nyc");
          assert.isFalse(provisioner.isolated);
          assert.strictEqual(Redacted.value(provisioner.token), "boat");
        }
        assert.isTrue(Option.isNone(provisioner.apiKeys.anthropic));
        assert.isTrue(Option.isNone(provisioner.apiKeys.openai));
        assert(Option.isSome(provisioner.tailnet));
        assert.strictEqual(Redacted.value(provisioner.tailnet.value.clientSecret), "client-secret");
        const decodedValue1 = jsonKey(worker);
        assert.notInclude(decodedValue1, "client-secret");
      }),
  );
}

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
