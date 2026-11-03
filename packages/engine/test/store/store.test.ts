import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { InstanceDirectory } from "@usine/core/instance";
import { Effect, FileSystem, Layer } from "effect";

import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { localSqliteLayer } from "../../src/database/local-sqlite.ts";

describe("run store", () => {
  it.live(
    "fails with a persistence error, not a defect, when the runtime store can't be opened",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: sqliteTempDirectory(),
          prefix: "usine-unopenable-store-",
        });
        // SQLite can't open a directory as a database file.
        yield* fs.makeDirectory(`${directory}/.usine/runtime.sqlite`, { recursive: true });
        const failure = yield* Layer.build(
          localSqliteLayer(InstanceDirectory.make(directory)),
        ).pipe(Effect.scoped, Effect.flip);
        assert.strictEqual(failure._tag, "EnginePersistenceError");
        assert.strictEqual(failure.operation, "open local database");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
