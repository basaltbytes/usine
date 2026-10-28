import { assert, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { ConfigProvider, Effect, Option, Redacted, Schema } from "effect";
import { sshWorkerAddressesOf } from "../src/ssh.ts";

it.effect(
  "resolves Boat OAuth variables without LLM API keys and reports a missing secret by variable name",
  () => {
    const config = Schema.decodeUnknownSync(UsineConfig)({
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
            llm_providers: ["anthropic", "openai"],
          },
          provisioner: {
            provider: "boat",
            token_env: "BOAT_TOKEN",
            snapshot: "usine-attempt",
            tailnet: {
              gateway_address: "100.64.0.2",
              client_id_env: "TS_CLIENT",
              client_secret_env: "TS_SECRET",
            },
          },
        },
      ],
    });
    const resolve = (env: Record<string, string>) =>
      sshWorkerAddressesOf(config).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      );
    return Effect.gen(function* () {
      const env = { GATEWAY_TOKEN: "admin", BOAT_TOKEN: "boat", TS_CLIENT: "client" };
      const missing = yield* resolve(env).pipe(Effect.flip);
      assert.include(missing.message, "TS_SECRET");
      assert.strictEqual(missing.capability, "gateway");
      const [worker] = yield* resolve({ ...env, TS_SECRET: "client-secret" });
      assert(
        worker?.machine._tag === "Provisioned" && worker.machine.provisioner.provider === "boat",
      );
      const provisioner = worker.machine.provisioner;
      assert.deepStrictEqual(provisioner.snapshot, Option.some("usine-attempt"));
      assert.isTrue(Option.isNone(provisioner.apiKeys.anthropic));
      assert.isTrue(Option.isNone(provisioner.apiKeys.openai));
      assert(Option.isSome(provisioner.tailnet));
      assert.strictEqual(Redacted.value(provisioner.tailnet.value.clientSecret), "client-secret");
      assert.notInclude(JSON.stringify(worker), "client-secret");
    });
  },
);
