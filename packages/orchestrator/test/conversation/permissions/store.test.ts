import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer } from "effect";
import { sqliteTempDirectory } from "../../../../../tooling/test/sqlite.mts";
import { memoryPermissionStoreLayer } from "../../../src/conversation/permissions/memory.ts";
import { sqlitePermissionStoreLayer } from "../../../src/conversation/permissions/sqlite.ts";
import { permissionStoreContract, type StoreAdapter } from "./contract.ts";

/** Reopening returns the same in-memory store, as a process that never restarted would. */
const memoryAdapter: StoreAdapter = {
  name: "memory",
  fixture: Layer.build(memoryPermissionStoreLayer).pipe(
    Effect.map((context) => ({ open: Layer.succeedContext(context) })),
  ),
};

const sqliteAdapter: StoreAdapter = {
  name: "sqlite",
  fixture: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: sqliteTempDirectory(),
      prefix: "usine-permission-contract-",
    });
    return {
      open: Layer.fresh(
        sqlitePermissionStoreLayer.pipe(
          Layer.provide(SqliteClient.layer({ filename: `${directory}/runtime.sqlite` })),
          Layer.orDie,
        ),
      ),
    };
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
};

for (const adapter of [memoryAdapter, sqliteAdapter]) permissionStoreContract(adapter);
