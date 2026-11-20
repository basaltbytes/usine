import { assert, it } from "@effect/vitest";
import { UsineConfig } from "@usine/config/factory";
import { Harness } from "@usine/core/agent/brain";
import {
  GatewayCredentialHolder,
  SshDestination,
  WorkerCredentialHolder,
  WorkerName,
} from "@usine/core/worker";
import { Effect, Schema } from "effect";
import { credentialHolderOf } from "../src/credential-holders.ts";

it.effect(
  "gives the Workers behind a Gateway its credential for the providers it lists, and each other Worker its own",
  () =>
    Effect.gen(function* () {
      const behindGateway = (name: string) =>
        ({
          name,
          kind: "ssh",
          destination: `${name}.test`,
          root: "/home/user/.usine",
          gateway: {
            domain: "gw.test",
            destination: "usine@gateway",
            admin_token_env: "GATEWAY_TOKEN",
            llm_providers: ["anthropic-messages"],
          },
        }) as const;
      const config = yield* Schema.decodeEffect(UsineConfig)({
        version: 1,
        repos: [],
        workers: [
          behindGateway("east"),
          behindGateway("west"),
          { name: "login", kind: "ssh", destination: "login.test", root: "/home/user/.usine" },
        ],
      });
      const holderOf = credentialHolderOf(config.workers);
      const claude = Harness.make("claude");
      const own = (worker: string) =>
        WorkerCredentialHolder.make({ worker: WorkerName.make(worker) });
      const gateway = GatewayCredentialHolder.make({
        destination: SshDestination.make("usine@gateway"),
      });
      assert.deepStrictEqual(holderOf(WorkerName.make("east"), claude), gateway);
      assert.deepStrictEqual(holderOf(WorkerName.make("west"), claude), gateway);
      // The Gateway doesn't list Codex's provider, so Codex uses each Worker's own login.
      assert.deepStrictEqual(holderOf(WorkerName.make("east"), Harness.make("codex")), own("east"));
      assert.deepStrictEqual(holderOf(WorkerName.make("login"), claude), own("login"));
      // A removed Worker whose Attempts still end holds its own credential.
      assert.deepStrictEqual(holderOf(WorkerName.make("removed"), claude), own("removed"));
    }),
);
