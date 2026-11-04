import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";

// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";

for (const [name, open] of [
  ["memory", async (_file: string) => new MemoryStorage()],
  ["sqlite", openNodeSqliteStorage],
] as const) {
  registerStorageConformance({ describe, expect, it }, `${name} durable storage contract`, (use) =>
    Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.makeTempDirectory({
            directory: sqliteTempDirectory(),
            prefix: "usine-durable-contract-",
          }),
        ),
        (directory) =>
          Effect.acquireUseRelease(
            Effect.promise<Storage>(() => open(join(directory, "durable.sqlite"))),
            (storage) => Effect.promise(() => use(storage)),
            (storage) => Effect.promise(() => storage.close(BACKGROUND_CONTEXT)),
          ),
        (directory) =>
          Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.remove(directory, { recursive: true, force: true }),
          ).pipe(Effect.orDie),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    ),
  );
}
