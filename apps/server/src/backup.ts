import type { InstanceDirectory } from "@usine/core/instance";
import { backup as backupDurableStorage } from "@usine/durable/backup";
import { backup as backupDatabase } from "@usine/engine/local-sqlite";
import { Console, Effect, FileSystem, Path } from "effect";

/** Returns the durable storage copy path: `backup.sqlite` becomes `backup.durable.sqlite`. */
const durableDestination = (path: Path.Path, destination: string): string => {
  const { dir, name, ext } = path.parse(destination);
  return ext === ".sqlite" || ext === ".db"
    ? path.join(dir, `${name}.durable${ext}`)
    : `${destination}.durable.sqlite`;
};

/**
 * Copies the instance's runtime database to `output` and its durable storage next to it, durable
 * storage first. If the runtime copy fails, removes the durable copy.
 */
export const backup = Effect.fn("Cli.backup")(function* (
  directory: InstanceDirectory,
  output: string,
) {
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
  yield* Console.log(`Backed up the runtime store to ${destination}`);
  yield* Console.log(
    copied
      ? `Backed up the durable storage to ${durable}`
      : "No durable storage to back up: .usine/durable.sqlite does not exist",
  );
});
