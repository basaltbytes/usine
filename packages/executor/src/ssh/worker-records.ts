import { catalog } from "@usine/agents/harness";
import type { SshCommand } from "@usine/agents/child-host";
import type { AttemptId } from "@usine/core/attempt";
import { safeSegment } from "@usine/core/repository";
import {
  SshDestination,
  SshIdentityFile,
  SshPort,
  WorkerName,
  WorkerRoot,
} from "@usine/core/worker";
import { type Brand, Effect, FileSystem, Option, Path, Schema } from "effect";
import { DEFAULT_SSH, remoteCommandsFor } from "../remote/commands.ts";
import { attemptHomeIn } from "./attempt-homes.ts";
import type { SshWorkerAddress } from "./model.ts";
import { sshCommandFor, workerDirectoryOf } from "./workers.ts";

/** How to reach a long-lived SSH Worker's machine. Holds no secret. */
class SshWorkerRecord extends Schema.Class<
  SshWorkerRecord,
  Brand.Brand<"@usine/executor/ssh/worker-records/SshWorkerRecord">
>("@usine/executor/SshWorkerRecord")({
  name: WorkerName,
  destination: SshDestination,
  port: Schema.OptionFromNullOr(SshPort),
  identityFile: Schema.OptionFromNullOr(SshIdentityFile),
  root: WorkerRoot,
}) {}

const SshWorkerRecordJson = Schema.fromJsonString(SshWorkerRecord);

/**
 * Records how to reach each long-lived SSH Worker's machine, one file per Worker in the local
 * `directory`, so that `discard` can remove the harness homes of a Worker's Attempts after
 * `usine.yaml` stops declaring it. `ssh` is the local SSH command and the options placed before
 * each Worker's port and key, `DEFAULT_SSH` if omitted.
 */
export const sshWorkerRecordsFor = Effect.fn("SshExecutor.workerRecordsFor")(function* (
  directory: string,
  ssh: SshCommand = DEFAULT_SSH,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commands = yield* remoteCommandsFor;
  const fileOf = (worker: WorkerName) => path.join(directory, `${safeSegment(worker)}.json`);

  /**
   * Records how to reach `address`'s machine, replacing the Worker's earlier record. Records
   * nothing for a provisioned Worker, whose machines are deleted with their Attempts. Never
   * fails; logs a failed write.
   */
  const remember = Effect.fn("SshExecutor.rememberWorker")(function* (address: SshWorkerAddress) {
    const worker = address.name;
    yield* Effect.annotateCurrentSpan({ worker });
    if (address.machine._tag !== "Fixed")
      return yield* Effect.logDebug(
        "Recorded no machine for the provisioned SSH Worker; its machines are deleted with their Attempts",
        { worker },
      );
    const { destination } = address.machine;
    const file = fileOf(worker);
    yield* Effect.gen(function* () {
      const text = yield* Schema.encodeEffect(SshWorkerRecordJson)(
        SshWorkerRecord.make({
          name: worker,
          destination,
          port: address.port,
          identityFile: address.identityFile,
          root: address.root,
        }),
      );
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(`${file}.next`, text);
      yield* fs.rename(`${file}.next`, file);
      yield* Effect.logDebug("Recorded how to reach the SSH Worker's machine", {
        worker,
        host: destination,
        file,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "Could not record how to reach the SSH Worker's machine; discarding its leftovers after usine.yaml stops declaring it leaves the harness homes of its Attempts",
          { worker, host: destination, file, message: error.message },
        ),
      ),
    );
  });

  /** Returns `worker`'s record, or `None` if it has none or can't be read, which it logs. */
  const recordOf = Effect.fn("SshExecutor.readWorkerRecord")(function* (worker: WorkerName) {
    const file = fileOf(worker);
    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(file))) {
        yield* Effect.logInfo(
          "No machine is recorded for the SSH Worker, so the harness homes of its discarded Attempts, if any, stay on it",
          { worker, file },
        );
        return Option.none<SshWorkerRecord>();
      }
      const text = yield* fs.readFileString(file);
      const sshWorkerRecord = yield* Schema.decodeEffect(SshWorkerRecordJson)(text);
      return Option.some(sshWorkerRecord);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "Could not read the SSH Worker's record, so the harness homes of its discarded Attempts stay on it",
          { worker, file, message: error.message },
        ).pipe(Effect.as(Option.none<SshWorkerRecord>())),
      ),
    );
  });

  /**
   * Removes the harness homes of `attempts` on `worker`'s machine, which the Worker's record gives.
   * Removes nothing if `worker` has no record, such as a provisioned Worker. Never fails; logs
   * what it couldn't remove.
   */
  const discard = Effect.fn("SshExecutor.discardAttemptHomes")(function* (
    worker: WorkerName,
    attempts: ReadonlyArray<AttemptId>,
  ) {
    yield* Effect.annotateCurrentSpan({ worker, attempts: attempts.length });
    if (attempts.length === 0) return;
    const record = yield* recordOf(worker);
    if (Option.isNone(record)) return;
    const { destination } = record.value;
    const workerDirectory = workerDirectoryOf(record.value);
    const attemptHomes = attempts.flatMap((attemptId) =>
      catalog.descriptors
        .filter(({ worker }) => Option.exists(worker.credential, ({ home }) => Option.isSome(home)))
        .map(({ id }) => attemptHomeIn(workerDirectory, attemptId, id)),
    );
    const fields = {
      worker,
      host: destination,
      directory: workerDirectory,
      attempts: attempts.length,
    };
    yield* commands
      .run("cleanup", commands.shellFor(sshCommandFor(ssh, record.value), destination), "rm", [
        "-rf",
        ...attemptHomes,
      ])
      .pipe(
        Effect.tap(() =>
          Effect.logInfo(
            "Removed the harness homes of the Attempts whose leftovers were discarded",
            fields,
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning(
            "Could not remove the harness homes of the Attempts whose leftovers were discarded; remove them from the Worker yourself",
            { ...fields, message: error.message },
          ),
        ),
      );
  });

  return { remember, discard };
});

/** The SSH Worker records in one directory. See `sshWorkerRecordsFor`. */
export type SshWorkerRecords = Effect.Success<ReturnType<typeof sshWorkerRecordsFor>>;
