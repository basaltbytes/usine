import { Repository, Worker } from "@usine/core";
import { Effect, PartitionedSemaphore, Ref } from "effect";
import { CredentialUnavailableError } from "../index.ts";
import type { ExeDevCommands } from "./commands.ts";
import {
  CredentialGrantMinutes,
  type ExeDevExecutorOptions,
  type IntegrationName,
} from "./model.ts";

const grantKey = (worker: Worker.Name, integration: IntegrationName): string =>
  `${worker}\u0000${integration}`;

export const credentialGrantsFor = Effect.fn("ExeDevExecutor.credentialGrantsFor")(function* (
  options: ExeDevExecutorOptions,
  commands: ExeDevCommands,
) {
  const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 });
  const counts = yield* Ref.make(new Map<string, number>());
  const grantMinutes = options.credentialGrantMinutes ?? CredentialGrantMinutes.make(65);

  const acquire = Effect.fn("ExeDevExecutor.acquireGrant")(function* (
    worker: Worker.Name,
    repository: Repository.Name,
    integration: IntegrationName,
  ) {
    const key = grantKey(worker, integration);
    yield* locks.withPermit(key)(
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
          activeGrants: current,
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
    worker: Worker.Name,
    integration: IntegrationName,
  ) {
    const key = grantKey(worker, integration);
    yield* locks.withPermit(key)(
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
          return;
        }
        yield* commands
          .lobby("cleanup", ["integrations", "detach", integration, `vm:${worker}`])
          .pipe(
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
