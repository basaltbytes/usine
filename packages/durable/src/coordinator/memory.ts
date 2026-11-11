import type { AttemptId } from "@usine/core/attempt";
import { Effect, HashMap, Layer, Option, Ref, Semaphore } from "effect";

import { AttemptJournal, type CoordinatorSnapshot } from "./journal.ts";
import {
  acknowledged,
  decided,
  keptDecision,
  opened,
  reserved,
  settled,
  transitioned,
} from "./ledger.ts";

/**
 * Provides an empty attempt journal in memory. Each layer build has its own state, and operations
 * apply one at a time.
 */
export const memoryAttemptJournalLayer = Layer.effect(
  AttemptJournal,
  Effect.gen(function* () {
    const journals = yield* Ref.make(HashMap.empty<AttemptId, CoordinatorSnapshot>());
    const lock = yield* Semaphore.make(1);
    const serialized = lock.withPermits(1);
    const stored = (attemptId: AttemptId) =>
      Ref.get(journals).pipe(
        Effect.flatMap((all) =>
          Option.match(HashMap.get(all, attemptId), {
            onNone: () => Effect.die(new Error(`Attempt ${attemptId} has no journal`)),
            onSome: Effect.succeed,
          }),
        ),
      );
    const save = (snapshot: CoordinatorSnapshot) =>
      Ref.update(journals, HashMap.set(snapshot.attemptId, snapshot));

    return AttemptJournal.of({
      open: Effect.fn("AttemptJournal.open")(function* (request) {
        const attemptId = request.spec.attemptId;
        yield* Effect.annotateCurrentSpan({ attemptId });
        return yield* Effect.gen(function* () {
          const all = yield* Ref.get(journals);
          const existing = HashMap.get(all, attemptId);
          if (Option.isSome(existing)) {
            yield* Effect.logInfo("Attempt journal already open; kept the first request", {
              attemptId,
            });
            return existing.value;
          }
          const snapshot = opened(request);
          yield* save(snapshot);
          yield* Effect.logInfo("Attempt journal opened", { attemptId });
          return snapshot;
        }).pipe(serialized);
      }),
      load: Effect.fn("AttemptJournal.load")(function* (attemptId) {
        yield* Effect.annotateCurrentSpan({ attemptId });
        const all = yield* Ref.get(journals);
        return HashMap.get(all, attemptId);
      }),
      transition: Effect.fn("AttemptJournal.transition")(
        function* (attemptId, expected, step) {
          yield* Effect.annotateCurrentSpan({ attemptId, expectedRevision: expected });
          return yield* Effect.gen(function* () {
            const previous = yield* stored(attemptId);
            const next = yield* transitioned(previous, expected, step);
            yield* save(next);
            return next;
          }).pipe(serialized);
        },
        Effect.tap((snapshot) =>
          Effect.logInfo("Attempt journal transition committed", {
            attemptId: snapshot.attemptId,
            revision: snapshot.revision,
            event: snapshot.events.length,
          }),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Attempt journal transition refused", {
            attemptId: error.attemptId,
            errorTag: error._tag,
          }),
        ),
      ),
      decide: Effect.fn("AttemptJournal.decide")(function* (attemptId, sequence, decision) {
        yield* Effect.annotateCurrentSpan({ attemptId, event: sequence });
        return yield* Effect.gen(function* () {
          const previous = yield* stored(attemptId);
          const result = yield* decided(previous, sequence, decision);
          if (result.snapshot !== previous) yield* save(result.snapshot);
          else yield* keptDecision(previous, sequence, result.recorded, decision);
          return result.recorded;
        }).pipe(serialized);
      }),
      reserve: Effect.fn("AttemptJournal.reserve")(function* (attemptId, envelopes) {
        yield* Effect.annotateCurrentSpan({ attemptId, envelopes: envelopes.length });
        yield* Effect.gen(function* () {
          const previous = yield* stored(attemptId);
          const next = yield* reserved(previous, envelopes);
          yield* save(next);
        }).pipe(serialized);
      }),
      acknowledge: Effect.fn("AttemptJournal.acknowledge")(function* (attemptId, through) {
        yield* Effect.annotateCurrentSpan({ attemptId, through });
        yield* Effect.gen(function* () {
          const previous = yield* stored(attemptId);
          yield* save(acknowledged(previous, through));
        }).pipe(serialized);
      }),
      settle: Effect.fn("AttemptJournal.settle")(function* (attemptId) {
        yield* Effect.annotateCurrentSpan({ attemptId });
        yield* Effect.gen(function* () {
          const all = yield* Ref.get(journals);
          const stored = HashMap.get(all, attemptId);
          if (Option.isNone(stored))
            return yield* Effect.logInfo("Skipped settling an Attempt that was never opened", {
              attemptId,
            });
          const next = settled(stored.value);
          if (Option.isNone(next))
            return yield* Effect.logInfo("Attempt journal already settled", { attemptId });
          yield* save(next.value);
          yield* Effect.logInfo("Attempt journal settled", { attemptId });
        }).pipe(serialized);
      }),
    });
  }),
);
