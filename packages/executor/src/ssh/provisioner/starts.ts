import type { MachineProvider, WorkerName } from "@usine/core/worker";
import { DateTime, Effect, FileSystem, Schema, SynchronizedRef } from "effect";
import { MachineStarts, WorkerCapabilityError } from "../../executor.ts";

const CountsJson = Schema.fromJsonString(Schema.Array(MachineStarts));

/** Persists daily creation counts independently of machine deletion. */
export const machineStartsFor = Effect.fn("SshExecutor.machineStartsFor")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const initial = (yield* fs.exists(file))
    ? yield* fs
        .readFileString(file)
        .pipe(
          Effect.flatMap((text) =>
            Schema.decodeEffect(CountsJson)(text, { onExcessProperty: "error" }),
          ),
        )
    : [];
  const counts = yield* SynchronizedRef.make<ReadonlyArray<MachineStarts>>(initial);
  const record = Effect.fn("SshExecutor.recordMachineStart")(function* (
    worker: WorkerName,
    provider: MachineProvider,
  ) {
    const observedAt = yield* DateTime.now;
    const day = DateTime.formatIso(observedAt).slice(0, 10);
    yield* Effect.annotateCurrentSpan({ worker, provider, day });
    yield* SynchronizedRef.updateEffect(counts, (current) =>
      Effect.gen(function* () {
        const previous = current.find(
          (entry) => entry.worker === worker && entry.provider === provider && entry.day === day,
        );
        const next = current
          .filter((entry) => entry !== previous)
          .concat(MachineStarts.make({ worker, provider, day, count: (previous?.count ?? 0) + 1 }));
        const countsJson = yield* Schema.encodeEffect(CountsJson)(next);
        yield* fs.writeFileString(`${file}.next`, countsJson);
        yield* fs.rename(`${file}.next`, file);
        yield* Effect.logInfo("Recorded a machine start", {
          worker,
          provider,
          day,
          count: (previous?.count ?? 0) + 1,
        });
        return next;
      }),
    ).pipe(
      Effect.uninterruptible,
      Effect.mapError((cause) =>
        WorkerCapabilityError.make({
          worker,
          capability: "machine",
          message: `Could not persist the machine start count: ${cause.message}`,
          cause,
        }),
      ),
    );
  });
  return {
    record,
    counts: SynchronizedRef.get(counts).pipe(
      Effect.map((entries) =>
        [...entries].sort(
          (left, right) =>
            left.day.localeCompare(right.day) ||
            left.worker.localeCompare(right.worker) ||
            left.provider.localeCompare(right.provider),
        ),
      ),
    ),
  };
});
