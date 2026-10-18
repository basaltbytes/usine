import { NodeServices } from "@effect/platform-node";
import { InstanceFolder } from "@usine/config/instance-folder";
import { ConfigParser } from "@usine/config/parser";
import type { InstanceDirectory } from "@usine/core/instance";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, FileSystem, Layer, Path } from "effect";
import { CurrentInstance } from "../../src/current-instance/current-instance.ts";

const instanceFolderLayer = InstanceFolder.layer.pipe(
  Layer.provide(ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer))),
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

/** The reloadable current instance over the folder at `root`, loaded the way `usine up` loads it. */
export const reloadableInstanceLayer = (root: InstanceDirectory) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const initial = yield* (yield* InstanceFolder).load(root);
      return CurrentInstance.layer(root, initial);
    }),
  ).pipe(Layer.provide(instanceFolderLayer));
