import type { AttemptId } from "@usine/core/attempt";
import type { LoopPermissions } from "@usine/core/loop";
import type { RepositoryName } from "@usine/core/repository";
import { Clock, DateTime, Effect, Redacted, SynchronizedRef } from "effect";
import type {
  CredentialProvider,
  CredentialUnavailableError,
  WorkerCredential,
} from "./executor.ts";

/** The remaining lifetime, in milliseconds, below which a new token is issued. */
const RENEWAL_WINDOW_MILLIS = 5 * 60_000;

interface RenewableCredential<A, E> {
  /** The return value of `publish` for the first token. */
  readonly published: A;
  /** Issues and publishes a new token if the current one expires within five minutes. */
  readonly refresh: () => Effect.Effect<void, E | CredentialUnavailableError>;
  /** Replaces every token issued for the Attempt in `text` with `[REDACTED]`. */
  readonly scrub: (text: string) => string;
}

/**
 * Issues the Attempt's single-repository token with its Loop `permissions`, passes it to
 * `publish`, and publishes a new one before each expiry until the caller's scope closes. Then
 * wipes every issued token, so `Redacted.value` throws. Register cleanup for what `publish`
 * writes before calling this, so the cleanup runs after renewal stops.
 */
export const renewableCredential = Effect.fn("Executor.renewableCredential")(function* <A, E>(
  issue: CredentialProvider["Service"]["issue"],
  repository: RepositoryName,
  attemptId: AttemptId,
  permissions: LoopPermissions,
  publish: (credential: WorkerCredential) => Effect.Effect<A, E>,
) {
  yield* Effect.annotateCurrentSpan({ repository, attemptId, permissions });
  const issued = new Set<Redacted.Redacted<string>>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const token of issued) Redacted.wipeUnsafe(token);
    }),
  );
  const publishFresh = Effect.fn("Executor.publishCredential")(function* () {
    yield* Effect.annotateCurrentSpan({ repository, attemptId, permissions });
    const credential = yield* issue(repository, attemptId, permissions);
    issued.add(credential.value);
    const published = yield* publish(credential);
    yield* Effect.logInfo("Published renewed Attempt repository credential", {
      repository,
      attemptId,
      permissions,
      expiresAt: DateTime.formatIso(credential.expiresAt),
    });
    return { expiresAt: credential.expiresAt, published };
  });
  const first = yield* publishFresh();
  const expiry = yield* SynchronizedRef.make(first.expiresAt);
  const refresh = Effect.fn("Executor.refreshCredential")(function* () {
    yield* Effect.annotateCurrentSpan({ repository, attemptId });
    yield* SynchronizedRef.updateEffect(expiry, (expiresAt) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (DateTime.toEpochMillis(expiresAt) - now > RENEWAL_WINDOW_MILLIS) return expiresAt;
        return (yield* publishFresh()).expiresAt;
      }),
    );
  });
  // Forked in a scope opened before the checkout finalizers, so renewal continues through
  // salvage and stops before the published credential is removed.
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
    published: first.published,
    refresh,
    scrub: (text: string): string => {
      for (const token of issued) text = text.replaceAll(Redacted.value(token), "[REDACTED]");
      return text;
    },
  } satisfies RenewableCredential<A, E>;
});
