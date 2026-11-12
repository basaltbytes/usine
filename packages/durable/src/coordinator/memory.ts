import type { AttemptId } from "@usine/core/attempt";
import { Effect, HashMap, Layer, Option, Ref, Semaphore } from "effect";

import { AttemptJournal, CoordinatorSnapshot } from "./journal.ts";
import {
  acknowledged,
  decided,
  delegationOf,
  inboundRecorded,
  inputForgotten,
  inputQueued,
  keptDecision,
  keptDelegationOutcome,
  opened,
  progressed,
  reserved,
  settled,
  settledDelegation,
  startedDelegation,
  supervised,
  transitioned,
  unsupervisedRecorded,
  withDelegation,
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
      startDelegation: Effect.fn("AttemptJournal.startDelegation")(function* (attemptId, number) {
        yield* Effect.annotateCurrentSpan({ attemptId, delegation: number });
        return yield* Effect.gen(function* () {
          const previous = yield* stored(attemptId);
          const record = yield* delegationOf(previous, number);
          const result = startedDelegation(record);
          yield* save(withDelegation(previous, result.record));
          return result.started;
        }).pipe(serialized);
      }),
      saveProgress: Effect.fn("AttemptJournal.saveProgress")(function* (attemptId, number, change) {
        yield* Effect.annotateCurrentSpan({ attemptId, delegation: number, change: change._tag });
        yield* Effect.gen(function* () {
          const previous = yield* stored(attemptId);
          const record = yield* delegationOf(previous, number).pipe(
            Effect.flatMap((current) => progressed(current, change)),
          );
          yield* save(withDelegation(previous, record));
        }).pipe(serialized);
      }),
      settleDelegation: Effect.fn("AttemptJournal.settleDelegation")(
        function* (attemptId, number, outcome) {
          yield* Effect.annotateCurrentSpan({ attemptId, delegation: number });
          return yield* Effect.gen(function* () {
            const previous = yield* stored(attemptId);
            const record = yield* delegationOf(previous, number);
            const result = settledDelegation(record, outcome);
            if (result.record !== record) yield* save(withDelegation(previous, result.record));
            else yield* keptDelegationOutcome(attemptId, number, result.recorded, outcome);
            return result.recorded;
          }).pipe(serialized);
        },
      ),
      recordResult: Effect.fn("AttemptJournal.recordResult")(function* (attemptId, result) {
        yield* Effect.annotateCurrentSpan({ attemptId });
        yield* Effect.gen(function* () {
          const previous = yield* stored(attemptId);
          yield* save(CoordinatorSnapshot.make({ ...previous, result: Option.some(result) }));
        }).pipe(serialized);
      }),
      recordUnsupervised: Effect.fn("AttemptJournal.recordUnsupervised")(
        function* (attemptId, unsupervised) {
          yield* Effect.annotateCurrentSpan({ attemptId });
          yield* Effect.gen(function* () {
            const previous = yield* stored(attemptId);
            yield* save(unsupervisedRecorded(previous, unsupervised));
          }).pipe(serialized);
        },
      ),
      supervise: Effect.fn("AttemptJournal.supervise")(function* (attemptId, supervision) {
        yield* Effect.annotateCurrentSpan({ attemptId, sessionId: supervision.sessionId });
        yield* Effect.gen(function* () {
          const previous = yield* stored(attemptId);
          yield* save(supervised(previous, supervision));
        }).pipe(serialized);
      }),
      queueInput: Effect.fn("AttemptJournal.queueInput")(function* (attemptId, input) {
        yield* Effect.annotateCurrentSpan({ attemptId, inputSequence: input.inputSequence });
        yield* Effect.gen(function* () {
          const previous = yield* stored(attemptId);
          yield* save(inputQueued(previous, input));
        }).pipe(serialized);
      }),
      forgetInput: Effect.fn("AttemptJournal.forgetInput")(
        function* (attemptId, inputSequence, receipts) {
          yield* Effect.annotateCurrentSpan({
            attemptId,
            inputSequence,
            receipts: receipts.length,
          });
          return yield* Effect.gen(function* () {
            const previous = yield* stored(attemptId);
            const { forgotten, snapshot } = inputForgotten(previous, inputSequence);
            const next = yield* reserved(snapshot, receipts);
            if (next !== previous) yield* save(next);
            return forgotten;
          }).pipe(serialized);
        },
      ),
      recordInbound: Effect.fn("AttemptJournal.recordInbound")(function* (attemptId, sequence) {
        yield* Effect.annotateCurrentSpan({ attemptId, inputSequence: sequence });
        yield* Effect.gen(function* () {
          const previous = yield* stored(attemptId);
          yield* save(inboundRecorded(previous, sequence));
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
      settleOpen: Effect.fn("AttemptJournal.settleOpen")(function* (attemptId) {
        yield* Effect.annotateCurrentSpan({ attemptId });
        return yield* Effect.gen(function* () {
          const all = yield* Ref.get(journals);
          const stored = HashMap.get(all, attemptId);
          if (Option.isNone(stored)) return Option.none();
          const { status } = stored.value;
          const next = settled(stored.value);
          if (status._tag === "Open" && Option.isSome(next)) {
            yield* save(next.value);
            yield* Effect.logInfo("Open attempt journal settled", { attemptId });
          }
          return Option.some(status);
        }).pipe(serialized);
      }),
    });
  }),
);
