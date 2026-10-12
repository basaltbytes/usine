import { InstanceDirectory } from "@usine/core/instance";
import { backup as backupDurableStorage } from "@usine/durable/backup";
import { backup as backupDatabase } from "@usine/engine/local-sqlite";
import { Console, Effect, FileSystem, Path } from "effect";

/** Where the durable storage copy goes, beside the runtime copy: `backup.sqlite` gives `backup.durable.sqlite`. */
const durableDestination = (path: Path.Path, destination: string): string => {
  const { dir, name, ext } = path.parse(destination);
  return path.join(dir, `${name}.durable${ext === "" ? ".sqlite" : ext}`);
};

/**
 * Copies the current instance's runtime database to `output`, resolved from the
 * working directory, and its durable storage beside it. The durable storage is
 * copied first, so the runtime copy is the newer one: an Attempt it shows open
 * either has its parent task in the durable copy or is retried. A failed runtime
 * copy removes the durable copy this call wrote.
 */
export const backup = Effect.fn("Cli.backup")(function* (output: string) {
  const directory = InstanceDirectory.make(process.cwd());
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = path.resolve(output);
  const durable = durableDestination(path, destination);
  yield* Effect.annotateCurrentSpan({ instanceDirectory: directory, destination, durable });
  const copied = yield* backupDurableStorage(directory, durable);
  yield* backupDatabase(directory, destination).pipe(
    Effect.tapError(() =>
      copied
        ? fileSystem.remove(durable).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not remove the durable copy of a failed backup", {
                durable,
                message: error.message,
              }),
            ),
            Effect.ignore,
          )
        : Effect.void,
    ),
  );
  yield* Console.log(`Backed up runtime store to ${destination}`);
  yield* Console.log(
    copied
      ? `Backed up durable storage to ${durable}`
      : "The instance has no durable storage (.usine/durable.sqlite) to back up",
  );
});
