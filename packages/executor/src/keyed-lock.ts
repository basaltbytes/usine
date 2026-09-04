import { Effect, Ref, Semaphore } from "effect";

export interface KeyedLock<in K> {
  readonly withLock: (
    key: K,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * One mutex per key. `PartitionedSemaphore` is not this: its `permits` option
 * is one shared pool and the partition key only orders waiters, so
 * `make({ permits: 1 })` serializes every key behind a single global permit.
 */
export const keyedLockFor = <K>(): Effect.Effect<KeyedLock<K>> =>
  Effect.map(Ref.make(new Map<K, Semaphore.Semaphore>()), (locks) => ({
    withLock: (key: K) => {
      const semaphore = Ref.modify(locks, (current) => {
        const existing = current.get(key);
        if (existing !== undefined) return [existing, current] as const;
        const created = Semaphore.makeUnsafe(1);
        const next = new Map(current);
        next.set(key, created);
        return [created, next] as const;
      });
      return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.flatMap(semaphore, (lock) => Semaphore.withPermit(lock, effect));
    },
  }));
