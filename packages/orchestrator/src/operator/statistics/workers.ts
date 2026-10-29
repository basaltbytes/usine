import {
  ConfigurationEntityId,
  ConfigurationEntityKey,
  ConfigurationStore,
  ConfigurationStoreError,
} from "@usine/config/configuration";
import { type Worker, WorkerFromYaml } from "@usine/config/factory";
import type { WorkerName } from "@usine/core/worker";
import { DateTime, Effect, Option, Schema } from "effect";
import { epoch } from "./window.ts";

export interface WorkerCapacity {
  readonly name: WorkerName;
  readonly slots: number;
  readonly initialSlots: number;
  readonly changes: ReadonlyArray<{ readonly at: DateTime.Utc; readonly slots: number }>;
}

export const readWorkerCapacity = Effect.fn("Operator.statistics.workerCapacity")(function* (
  store: Pick<ConfigurationStore["Service"], "list">,
  worker: Worker,
) {
  yield* Effect.annotateCurrentSpan({ worker: worker.name });
  const key = new ConfigurationEntityKey({
    kind: "worker",
    identifier: ConfigurationEntityId.make(worker.name),
  });
  const revisions = yield* store.list(Option.some(key));
  const changes = yield* Effect.forEach(
    revisions.flatMap((revision) =>
      revision.changes
        .filter((change) => change.key.key === key.key)
        .map((change) => ({ revision, change })),
    ),
    ({ revision, change }) =>
      Option.match(change.after, {
        onNone: () => Effect.succeed(0),
        onSome: (value) =>
          Schema.decodeUnknownEffect(WorkerFromYaml)(value).pipe(
            Effect.map(({ maxConcurrentAttempts }) => maxConcurrentAttempts),
            Effect.mapError(
              (cause) =>
                new ConfigurationStoreError({ operation: "decode worker slot history", cause }),
            ),
          ),
      }).pipe(Effect.map((slots) => ({ at: revision.time, slots, revision: revision.number }))),
  );
  changes.sort((left, right) => epoch(left.at) - epoch(right.at) || left.revision - right.revision);
  const initial = changes.find(({ revision }) => revision === 1);
  const initialSlots = initial?.slots ?? (changes.length === 0 ? worker.maxConcurrentAttempts : 0);
  yield* Effect.logDebug("Read worker slot history", {
    worker: worker.name,
    revisions: revisions.length,
    initialSlots,
    source: changes.length === 0 ? "current configuration" : "configuration revisions",
  });
  return {
    name: worker.name,
    slots: worker.maxConcurrentAttempts,
    initialSlots,
    changes,
  } satisfies WorkerCapacity;
});

/** Integrates slot capacity over the window, in slot-milliseconds. */
export const workerSlotMillis = (worker: WorkerCapacity, from: number, to: number): number => {
  let slots = worker.initialSlots;
  let start = from;
  let total = 0;
  for (const change of worker.changes) {
    const end = Math.max(from, Math.min(to, epoch(change.at)));
    total += slots * (end - start);
    slots = change.slots;
    start = end;
  }
  return total + slots * Math.max(0, to - start);
};
