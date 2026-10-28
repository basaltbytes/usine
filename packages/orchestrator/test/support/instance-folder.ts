import { NodeServices } from "@effect/platform-node";
import {
  Configuration,
  ConfigurationRevisionNumber,
  ConfigurationStore,
  ConfigurationStoreError,
} from "@usine/config/configuration";
import { InstanceFolder } from "@usine/config/instance-folder";
import { ConfigParser } from "@usine/config/parser";
import type { InstanceDirectory } from "@usine/core/instance";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, FileSystem, Layer, Path, Option, Stream } from "effect";
import { CurrentInstance } from "../../src/current-instance/current-instance.ts";

const instanceFolderLayer = InstanceFolder.layer.pipe(
  Layer.provideMerge(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
  Layer.provide(NodeServices.layer),
);

/** Writes each `[path, contents]` pair under `root`, creating the folders it needs. */
export const writeInstanceFiles = Effect.fn("test.writeInstanceFiles")(function* (
  root: InstanceDirectory,
  files: ReadonlyArray<readonly [string, string]>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [file, contents] of files) {
    const target = path.join(root, file);
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.writeFileString(target, contents);
  }
});

/** The reloadable current instance over the folder at `root`, loaded as `usine up` loads it. */
export const reloadableInstanceLayer = (root: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const folder = yield* InstanceFolder;
      const initial = yield* folder.load(root);
      const number = ConfigurationRevisionNumber.make(1);
      const unused = () => Effect.die("unused store operation");
      return CurrentInstance.layer(root, initial, number).pipe(
        Layer.provide(
          Layer.succeed(ConfigurationStore)({
            read: folder.load(root).pipe(
              Effect.map(
                (instance) => new Configuration({ number, instance: Option.some(instance) }),
              ),
              Effect.mapError(
                (cause) => new ConfigurationStoreError({ operation: "test read", cause }),
              ),
            ),
            list: unused,
            revision: unused,
            commit: unused,
            changes: () => Stream.never,
          }),
        ),
      );
    }),
  ).pipe(Layer.provide(instanceFolderLayer));
