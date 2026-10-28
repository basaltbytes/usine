import type { RunDatabase } from "@usine/engine/database";
import type { EnginePersistenceError } from "@usine/engine/engine";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import type { UsineConfig } from "@usine/config/factory";
import type { BrainSpec } from "@usine/core/agent/brain";
import type { InstanceDirectory, InstanceId } from "@usine/core/instance";
import { GitHubCredentials } from "@usine/github/github-app";
import { Effect, Layer, Option } from "effect";
import { cloudflareWorkersOf, layer as cloudflareLayer } from "./cloudflare.ts";
import { layer as localLayer } from "./local.ts";
import { layer as sshLayer, sshWorkerRecordsDirectory, sshWorkersOf } from "./ssh.ts";

/**
 * Provides the engine for the Workers in `config`: the SSH executor if every Worker is `ssh`, the
 * Cloudflare executor if every Worker is `cloudflare`, otherwise the local one. Fails at startup
 * with `UnsupportedWorkerError` on any other mix. The SSH executor labels its Attempt containers
 * with `instanceId`, so that instances that share the GitHub App and a machine keep each other's.
 */
export const workerEngineLayer = (
  instanceDirectory: InstanceDirectory,
  instanceId: InstanceId,
  config: UsineConfig,
  brains: ReadonlyArray<BrainSpec>,
  database: Layer.Layer<RunDatabase, EnginePersistenceError> = localSqliteLayer(instanceDirectory),
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const ssh = sshWorkersOf(config);
      const workers = config.workers.map(({ name }) => name).join(",");
      if (ssh.length === config.workers.length) {
        // The GitHub App is the instance's identity (ADR 0011).
        const { appId } = yield* GitHubCredentials;
        const instance = `github-app-${String(appId)}`;
        yield* Effect.logInfo("Running Attempts on SSH Workers", {
          workers,
          instance,
          instanceId,
          behindGateway: ssh
            .filter(({ gateway }) => Option.isSome(gateway))
            .map(({ name }) => name)
            .join(","),
          provisioned: ssh
            .filter(({ provisioner }) => Option.isSome(provisioner))
            .map(({ name }) => name)
            .join(","),
        });
        return sshLayer(
          instanceDirectory,
          config,
          brains,
          {
            workers: [],
            instance,
            instanceId,
            knownHostsDirectory: `${instanceDirectory}/.usine/known-hosts`,
            workerRecordsDirectory: sshWorkerRecordsDirectory(instanceDirectory),
          },
          database,
        );
      }
      if (cloudflareWorkersOf(config).length === config.workers.length) {
        // The GitHub App is the instance's identity (ADR 0011).
        const { appId } = yield* GitHubCredentials;
        const instance = `github-app-${String(appId)}`;
        yield* Effect.logInfo("Running Attempts in Cloudflare sandboxes", {
          workers,
          instance,
          workerUrls: cloudflareWorkersOf(config)
            .map(({ workerUrl }) => workerUrl.origin)
            .join(","),
        });
        return cloudflareLayer(
          instanceDirectory,
          config,
          brains,
          { workers: [], instance },
          database,
        );
      }
      yield* Effect.logInfo("Running Attempts with the local executor", { workers });
      return localLayer(instanceDirectory, config, brains, {}, database);
    }),
  );
