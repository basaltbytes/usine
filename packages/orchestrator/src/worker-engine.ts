import type { UsineConfig } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { InstanceDirectory } from "@usine/core/instance";
import { GitHubCredentials } from "@usine/github/github-app";
import { Effect, Layer, Option } from "effect";
import { layer as localLayer } from "./local.ts";
import { layer as sshLayer, sshWorkerAddressesOf, sshWorkersOf } from "./ssh.ts";

/**
 * Provides the engine for the Workers in `config`: the SSH executor if every Worker is `ssh`,
 * otherwise the local one. Fails at startup with `UnsupportedWorkerError` on any other mix.
 */
export const workerEngineLayer = (
  instanceDirectory: InstanceDirectory,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const ssh = sshWorkersOf(config);
      const workers = config.workers.map(({ name }) => name).join(",");
      if (ssh.length === config.workers.length) {
        const addresses = yield* sshWorkerAddressesOf(config);
        // The GitHub App is the instance's identity (ADR 0011).
        const { appId } = yield* GitHubCredentials;
        const instance = `github-app-${String(appId)}`;
        yield* Effect.logInfo("Running Attempts on SSH Workers", {
          workers,
          instance,
          behindGateway: addresses
            .filter(({ gateway }) => Option.isSome(gateway))
            .map(({ name }) => name)
            .join(","),
          provisioned: addresses
            .filter(({ machine }) => machine._tag === "Provisioned")
            .map(({ name }) => name)
            .join(","),
        });
        return sshLayer(instanceDirectory, config, brains, {
          workers: addresses,
          instance,
          knownHostsDirectory: `${instanceDirectory}/.usine/known-hosts`,
        });
      }
      yield* Effect.logInfo("Running Attempts with the local executor", { workers });
      return localLayer(instanceDirectory, config, brains, {});
    }),
  );
