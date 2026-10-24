import type { AttemptId } from "@usine/core/attempt";
import type { LoopPermissions } from "@usine/core/loop";
import type { RepositoryName } from "@usine/core/repository";
import { Effect, FileSystem, Redacted } from "effect";
import { credentialEnvironment, GH_CONFIG, ghHostsConfig } from "../credential-environment.ts";
import { CredentialProvider, ExecutorOperationError, type WorkerCredential } from "../executor.ts";
import { renewableCredential } from "../renewable-credential.ts";

/**
 * Writes the Attempt's renewed credential to a private temporary directory outside the
 * checkout, removed when the Attempt scope closes.
 */
export const localCredentialsFor = Effect.gen(function* () {
  const provider = yield* CredentialProvider;
  const fs = yield* FileSystem.FileSystem;
  return Effect.fn("LocalExecutor.credentials")(
    function* (
      repository: RepositoryName,
      attemptId: AttemptId,
      permissions: LoopPermissions,
      baseEnvironment: Record<string, string>,
    ) {
      yield* Effect.annotateCurrentSpan({ repository, attemptId, permissions });
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-credentials-" });
      yield* fs.chmod(directory, 0o700);
      yield* fs.writeFileString(`${directory}/config.yml`, GH_CONFIG, { mode: 0o600 });
      const { refresh, scrub } = yield* renewableCredential(
        provider.issue,
        repository,
        attemptId,
        permissions,
        Effect.fn("LocalExecutor.writeCredential")(function* ({ value }: WorkerCredential) {
          // Writes then renames so readers never see a partial token.
          yield* fs.writeFileString(`${directory}/token.next`, Redacted.value(value), {
            mode: 0o600,
          });
          yield* fs.rename(`${directory}/token.next`, `${directory}/token`);
          yield* fs.writeFileString(
            `${directory}/hosts.next`,
            ghHostsConfig(Redacted.value(value)),
            {
              mode: 0o600,
            },
          );
          yield* fs.rename(`${directory}/hosts.next`, `${directory}/hosts.yml`);
        }),
      );
      return {
        refresh,
        scrub,
        environment: { ...baseEnvironment, ...credentialEnvironment(directory) },
      };
    },
    (effect) =>
      effect.pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            new ExecutorOperationError({
              operation: "prepare",
              message: "Can't write the attempt's credential files",
              cause,
            }),
          ),
        ),
      ),
  );
});
