import { RepositoryName, WorkerName } from "@usine/core/ids";
import { Effect, Ref } from "effect";
import { CredentialUnavailableError } from "../executor.ts";
import { keyedLockFor } from "../keyed-lock.ts";
import type { ExeDevCommands } from "./commands.ts";
import {
  CredentialGrantMinutes,
  type ExeDevExecutorOptions,
  type IntegrationName,
} from "./model.ts";

const grantKey = (worker: WorkerName, integration: IntegrationName): string =>
  `${worker} ${integration}`;

export const credentialGrantsFor = Effect.fn("ExeDevExecutor.credentialGrantsFor")(function* (
  options: ExeDevExecutorOptions,
  commands: ExeDevCommands,
) {
  const locks = yield* keyedLockFor<string>();
  const counts = yield* Ref.make(new Map<string, number>());
  const grantMinutes = options.credentialGrantMinutes ?? CredentialGrantMinutes.make(65);

  const acquire = Effect.fn("ExeDevExecutor.acquireGrant")(function* (
    worker: WorkerName,
    repository: RepositoryName,
    integration: IntegrationName,
  ) {
    const key = grantKey(worker, integration);
    yield* locks.withLock(key)(
      Effect.gen(function* () {
        const current = (yield* Ref.get(counts)).get(key) ?? 0;
        yield* commands
          .lobby("prepare", [
            "integrations",
            "attach",
            integration,
            `vm:${worker}`,
            "--for",
            `${grantMinutes}m`,
          ])
          .pipe(
            Effect.mapError(
              (cause) =>
                new CredentialUnavailableError({
                  repository,
                  message: `Could not attach exe.dev GitHub integration ${integration}`,
                  cause,
                }),
            ),
          );
        yield* Effect.logInfo("Attached or refreshed time-boxed exe.dev GitHub integration", {
          worker,
          repository,
          integration,
          grantMinutes,
          activeGrants: current + 1,
        });
        yield* Ref.update(counts, (currentCounts) => {
          const next = new Map(currentCounts);
          next.set(key, current + 1);
          return next;
        });
      }),
    );
  });

  const release = Effect.fn("ExeDevExecutor.releaseGrant")(function* (
    worker: WorkerName,
    integration: IntegrationName,
  ) {
    const key = grantKey(worker, integration);
    yield* locks.withLock(key)(
      Effect.gen(function* () {
        const current = (yield* Ref.get(counts)).get(key) ?? 0;
        if (current === 0) {
          yield* Effect.logDebug("Credential cleanup was already complete", {
            worker,
            integration,
          });
          return;
        }
        if (current > 1) {
          yield* Ref.update(counts, (currentCounts) => {
            const next = new Map(currentCounts);
            next.set(key, current - 1);
            return next;
          });
          yield* Effect.logDebug("Kept the shared exe.dev GitHub integration", {
            worker,
            integration,
            activeGrants: current - 1,
          });
          return;
        }
        yield* commands
          .lobby("cleanup", ["integrations", "detach", integration, `vm:${worker}`])
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not detach the exe.dev GitHub integration", {
                worker,
                integration,
                grantMinutes,
                lapse: `the grant stays attached until its ${grantMinutes}m time-box expires`,
                message: error.message,
              }),
            ),
            Effect.ensuring(
              Ref.update(counts, (currentCounts) => {
                const next = new Map(currentCounts);
                next.delete(key);
                return next;
              }),
            ),
          );
        yield* Effect.logInfo("Detached exe.dev GitHub integration", {
          worker,
          integration,
        });
      }),
    );
  });

  return { acquire, release };
});
