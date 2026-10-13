import type { AttemptId } from "@usine/core/attempt";
import type { RepositoryName } from "@usine/core/repository";
import { Effect, FileSystem, Redacted } from "effect";
import { credentialEnvironment, GH_CONFIG, ghHostsConfig } from "../credential-environment.ts";
import { CredentialProvider, ExecutorOperationError } from "../executor.ts";
import { renewableCredential } from "../renewable-credential.ts";

/**
 * Publishes the Attempt's renewed credential in a private temporary directory
 * that belongs to the Attempt scope, outside its salvaged checkout.
 */
export const localCredentialsFor = Effect.gen(function* () {
  const provider = yield* CredentialProvider;
  const fs = yield* FileSystem.FileSystem;
  return Effect.fn("LocalExecutor.credentials")(
    function* (
      repository: RepositoryName,
      attemptId: AttemptId,
      baseEnvironment: Record<string, string>,
    ) {
      yield* Effect.annotateCurrentSpan({ repository, attemptId });
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-credentials-" });
      yield* fs.chmod(directory, 0o700);
      yield* fs.writeFileString(`${directory}/config.yml`, GH_CONFIG, { mode: 0o600 });
      const credential = yield* renewableCredential(
        provider.issue,
        repository,
        attemptId,
        Effect.fn("LocalExecutor.writeCredential")(function* (token: Redacted.Redacted<string>) {
          // Rename prevents readers observing truncated credentials during renewal.
          yield* fs.writeFileString(`${directory}/token.next`, Redacted.value(token), {
            mode: 0o600,
          });
          yield* fs.rename(`${directory}/token.next`, `${directory}/token`);
          yield* fs.writeFileString(
            `${directory}/hosts.next`,
            ghHostsConfig(Redacted.value(token)),
            {
              mode: 0o600,
            },
          );
          yield* fs.rename(`${directory}/hosts.next`, `${directory}/hosts.yml`);
        }),
      );
      return {
        ...credential,
        environment: { ...baseEnvironment, ...credentialEnvironment(directory) },
      };
    },
    (effect) =>
      effect.pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            new ExecutorOperationError({
              operation: "prepare",
              message: "Could not publish Attempt credentials",
              cause,
            }),
          ),
        ),
      ),
  );
});
