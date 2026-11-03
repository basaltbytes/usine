import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";
import { RunStore } from "../../src/store/store.ts";

export { lifecycleSubmission, testAgent } from "./fixtures.ts";

export const withRunStore = <A, E>(effect: Effect.Effect<A, E, RunStore | SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = InstanceDirectory.make(
      yield* fileSystem.makeTempDirectoryScoped({
        directory: sqliteTempDirectory(),
        prefix: "usine-store-lifecycle-",
      }),
    );
    return yield* effect.pipe(
      Effect.provide(Layer.mergeAll(RunStore.layer, localSqliteLayer(directory))),
    );
  }).pipe(Effect.provide(NodeServices.layer));
