import type { AttemptId } from "@usine/core/attempt";
import type { RepositoryName } from "@usine/core/repository";
import { Clock, DateTime, Effect, Redacted, SynchronizedRef } from "effect";
import type {
  CredentialProvider,
  CredentialUnavailableError,
  WorkerCredential,
} from "./executor.ts";

/** Renewal publishes a fresh token once the current one expires within this window. */
const RENEWAL_WINDOW_MILLIS = 5 * 60_000;

/** An Attempt's repository credential, published for its processes and renewed while the caller's scope is open. */
interface RenewableCredential<A, E> {
  /** What publishing the first token returned. */
  readonly published: A;
  /** Publishes a fresh token when the current one expires within five minutes. */
  readonly refresh: () => Effect.Effect<void, E | CredentialUnavailableError>;
  /** Replaces every token issued for the Attempt in `text` with `[REDACTED]`. */
  readonly scrub: (text: string) => string;
}

/**
 * Issues the Attempt's single-repository token, hands it with its expiry to
 * `publish`, and keeps publishing a fresh one before it expires until the
 * caller's scope closes; every issued token is wiped from memory then.
 * Register the cleanup of whatever `publish` writes or attaches before
 * calling this, so it runs after renewal has stopped.
 */
export const renewableCredential = Effect.fn("Executor.renewableCredential")(function* <A, E>(
  issue: CredentialProvider["Service"]["issue"],
  repository: RepositoryName,
  attemptId: AttemptId,
  publish: (credential: WorkerCredential) => Effect.Effect<A, E>,
) {
  yield* Effect.annotateCurrentSpan({ repository, attemptId });
  const issued = new Set<Redacted.Redacted<string>>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const token of issued) Redacted.wipeUnsafe(token);
    }),
  );
  const publishFresh = Effect.fn("Executor.publishCredential")(function* () {
    yield* Effect.annotateCurrentSpan({ repository, attemptId });
    const credential = yield* issue(repository, attemptId);
    issued.add(credential.value);
    const published = yield* publish(credential);
    yield* Effect.logInfo("Published renewed Attempt repository credential", {
      repository,
      attemptId,
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
  // This scope predates checkout finalizers, so renewal remains alive through
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
