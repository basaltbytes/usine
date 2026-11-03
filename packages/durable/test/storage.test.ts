import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";

for (const [name, open] of [
  ["memory", async (_file: string) => new MemoryStorage()],
  ["sqlite", openNodeSqliteStorage],
] as const) {
  registerStorageConformance(
    { describe, expect, it },
    `${name} durable storage contract`,
    async (use) => {
      const directory = await mkdtemp(join(sqliteTempDirectory(), "usine-durable-contract-"));
      try {
        const storage: Storage = await open(join(directory, "durable.sqlite"));
        try {
          await use(storage);
        } finally {
          await storage.close(BACKGROUND_CONTEXT);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
