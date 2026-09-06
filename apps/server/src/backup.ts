import { InstanceDirectory } from "@usine/core/instance";
import { backup as backupDatabase } from "@usine/engine/local-sqlite";
import { Console, Effect, Path } from "effect";

/** Backs up the current instance without credentials or starting execution. */
export const backup = Effect.fn("Cli.backup")(function* (output: string) {
  const directory = InstanceDirectory.make(process.cwd());
  const path = yield* Path.Path;
  const destination = path.resolve(output);
  yield* Effect.annotateCurrentSpan({ instanceDirectory: directory, destination });
  yield* backupDatabase(directory, destination);
  yield* Console.log(`Backed up runtime store to ${destination}`);
});
