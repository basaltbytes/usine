import { type Duration, Effect, type Predicate, Schedule } from "effect";

/** A failure that `retryTransient` retries. */
export interface TransientRetry<E> {
  readonly error: E;
  /** The number of the retry about to start, from 1. */
  readonly retry: number;
  /** The wait before the retry starts. */
  readonly delay: Duration.Duration;
}

/** Applies a `retryTransient` policy to an effect that fails with `E` or a subtype. */
export type TransientRetrying<E, R2> = <A, E2 extends E, R>(
  effect: Effect.Effect<A, E2, R>,
) => Effect.Effect<A, E2, R | R2>;

/**
 * Retries `effect` at most twice while `transient` accepts its failure, about 1 and then 3
 * seconds later, with jitter. Runs `onRetry` before each retry with the accepted failure, narrowed
 * to `T`. Fails with the last failure.
 */
export function retryTransient<E, T extends E, R2 = never>(
  transient: Predicate.Refinement<E, T>,
  onRetry: (retry: TransientRetry<T>) => Effect.Effect<void, never, R2>,
): TransientRetrying<E, R2>;
/**
 * Retries `effect` at most twice while `transient` accepts its failure, about 1 and then 3
 * seconds later, with jitter. Runs `onRetry` before each retry. Fails with the last failure.
 */
export function retryTransient<E, R2 = never>(
  transient: Predicate.Predicate<E>,
  onRetry: (retry: TransientRetry<E>) => Effect.Effect<void, never, R2>,
): TransientRetrying<E, R2>;
export function retryTransient<E, R2>(
  transient: Predicate.Predicate<E>,
  onRetry: (retry: TransientRetry<E>) => Effect.Effect<void, never, R2>,
): TransientRetrying<E, R2> {
  return (effect) =>
    effect.pipe(
      Effect.retry(($) =>
        $(Schedule.exponential("1 second", 3)).pipe(
          Schedule.jittered,
          Schedule.while(({ input }) => transient(input)),
          Schedule.upTo({ times: 2 }),
          // `while` and `upTo` end the schedule before `tap` sees a failure that isn't retried.
          Schedule.tap(({ input, attempt, duration }) =>
            onRetry({ error: input, retry: attempt, delay: duration }),
          ),
        ),
      ),
    );
}
