import { Worker } from "@usine/config/factory";
import type { AttemptId } from "@usine/core/attempt";
import { safeSegment } from "@usine/core/repository";
import type { WorkerName } from "@usine/core/worker";
import {
  type AttemptConnections,
  ExecutorOperationError,
  type WorkerCapabilityError,
} from "@usine/executor";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

const WorkerJson = Schema.fromJsonString(Worker);

/** Stores configuration with credential variable names before an attempt allocates resources. */
export const workerConnectionsFor = <A extends { readonly name: WorkerName }>(
  directory: string,
  addressOf: (worker: Worker) => Effect.Effect<A, WorkerCapabilityError>,
  initial: ReadonlyArray<{ readonly worker: Worker; readonly address: A }>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configurations = new WeakMap<A, Worker>();
    const addresses = new Map<string, A>();
    for (const { worker, address } of initial) configurations.set(address, worker);
    const failure = (attemptId: AttemptId, cause: unknown) =>
      ExecutorOperationError.make({
        operation: "prepare",
        message: `Can't read or record the worker connection for attempt ${attemptId}`,
        cause,
      });
    const fileOf = (attemptId: AttemptId) => path.join(directory, `${safeSegment(attemptId)}.json`);
    const resolve = Effect.fn("Orchestrator.resolveWorkerConnection")(function* (worker: Worker) {
      yield* Effect.annotateCurrentSpan({ worker: worker.name });
      const key = Schema.encodeSync(WorkerJson)(worker);
      const cached = addresses.get(key);
      if (cached !== undefined) return cached;
      const address = yield* addressOf(worker);
      configurations.set(address, worker);
      addresses.set(key, address);
      return address;
    });
    const read = Effect.fn("Orchestrator.readAttemptConnection")(function* (attemptId: AttemptId) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      const file = fileOf(attemptId);
      const worker = yield* Effect.gen(function* () {
        if (!(yield* fs.exists(file))) return Option.none<Worker>();
        return Option.some(
          yield* Schema.decodeEffect(WorkerJson)(yield* fs.readFileString(file), {
            onExcessProperty: "error",
          }),
        );
      }).pipe(Effect.mapError((cause) => failure(attemptId, cause)));
      return yield* Effect.transposeOption(Option.map(worker, resolve));
    });
    const write = Effect.fn("Orchestrator.writeAttemptConnection")(function* (
      attemptId: AttemptId,
      address: A,
    ) {
      yield* Effect.annotateCurrentSpan({ attemptId, worker: address.name });
      const worker = configurations.get(address);
      if (worker === undefined)
        return yield* Effect.die(new Error(`Unregistered worker connection for ${address.name}`));
      const file = fileOf(attemptId);
      yield* Effect.gen(function* () {
        const text = yield* Schema.encodeEffect(WorkerJson)(worker);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(`${file}.next`, text, { mode: 0o600 });
        yield* fs.rename(`${file}.next`, file);
      }).pipe(Effect.mapError((cause) => failure(attemptId, cause)));
      yield* Effect.logDebug("Persisted the attempt's worker configuration", {
        attemptId,
        worker: address.name,
      });
    });
    const remove = Effect.fn("Orchestrator.removeAttemptConnection")(function* (
      attemptId: AttemptId,
    ) {
      yield* Effect.annotateCurrentSpan({ attemptId });
      yield* fs
        .remove(fileOf(attemptId), { force: true })
        .pipe(Effect.mapError((cause) => failure(attemptId, cause)));
    });
    return { resolve, store: { read, write, remove } satisfies AttemptConnections<A> };
  });
