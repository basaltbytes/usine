import type { AttemptId } from "@usine/core/attempt";
import type { RepositoryName } from "@usine/core/repository";
import { Clock, DateTime, Effect, FileSystem, Redacted, SynchronizedRef } from "effect";
import { CredentialProvider, ExecutorOperationError } from "../executor.ts";

/**
 * Git reads the token file for each authentication; gh reads the renewed hosts
 * configuration on each invocation. No expiring token is frozen in child env.
 * Both files belong to the Attempt scope, outside its salvaged checkout.
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
      yield* fs.writeFileString(`${directory}/config.yml`, 'version: "1"\n', { mode: 0o600 });
      const issued = new Set<Redacted.Redacted<string>>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const token of issued) Redacted.wipeUnsafe(token);
        }),
      );
      const publish = Effect.fn("LocalExecutor.publishCredential")(function* () {
        yield* Effect.annotateCurrentSpan({ repository, attemptId });
        const credential = yield* provider.issue(repository, attemptId);
        issued.add(credential.value);
        const token = Redacted.value(credential.value);
        // Rename prevents readers observing truncated credentials during renewal.
        yield* fs.writeFileString(`${directory}/token.next`, token, { mode: 0o600 });
        yield* fs.rename(`${directory}/token.next`, `${directory}/token`);
        yield* fs.writeFileString(
          `${directory}/hosts.next`,
          `github.com:\n    user: x-access-token\n    oauth_token: ${JSON.stringify(token)}\n    git_protocol: https\n    users:\n        x-access-token:\n            oauth_token: ${JSON.stringify(token)}\n`,
          { mode: 0o600 },
        );
        yield* fs.rename(`${directory}/hosts.next`, `${directory}/hosts.yml`);
        yield* Effect.logInfo("Published renewed Attempt repository credential", {
          repository,
          attemptId,
          expiresAt: DateTime.formatIso(credential.expiresAt),
        });
        return credential.expiresAt;
      });
      const expiry = yield* SynchronizedRef.make(yield* publish());
      const refresh = Effect.fn("LocalExecutor.refreshCredential")(function* () {
        yield* Effect.annotateCurrentSpan({ repository, attemptId });
        yield* SynchronizedRef.updateEffect(expiry, (expiresAt) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (DateTime.toEpochMillis(expiresAt) - now > 5 * 60_000) return expiresAt;
            return yield* publish();
          }),
        );
      });
      // This scope predates checkout finalizers, so renewal remains alive through
      // salvage and stops before credential files are removed.
      yield* Effect.forever(
        Effect.sleep("30 seconds").pipe(
          Effect.andThen(refresh()),
          Effect.tapError((error) =>
            Effect.logWarning("Attempt credential renewal failed; will retry", {
              repository,
              attemptId,
              message: String(error),
            }),
          ),
          Effect.ignore,
        ),
      ).pipe(Effect.forkScoped);
      return {
        refresh,
        environment: {
          ...baseEnvironment,
          GH_CONFIG_DIR: directory,
          GH_PROMPT_DISABLED: "1",
          USINE_GITHUB_TOKEN_FILE: `${directory}/token`,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_KEY_1: "credential.helper",
          GIT_CONFIG_VALUE_1:
            '!f() { if [ "$1" = get ]; then echo username=x-access-token; printf "password="; cat "$USINE_GITHUB_TOKEN_FILE"; echo; fi; }; f',
        },
        scrub: (text: string): string => {
          for (const token of issued) text = text.replaceAll(Redacted.value(token), "[REDACTED]");
          return text;
        },
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
