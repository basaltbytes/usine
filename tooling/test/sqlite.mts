import { accessSync, constants, statfsSync } from "node:fs";
import { tmpdir } from "node:os";

/** Selects writable tmpfs storage for SQLite fixtures, or the OS temporary directory. */
export const sqliteTempDirectory = (memoryDirectory = "/dev/shm"): string => {
  try {
    // TMPFS_MAGIC from Linux's statfs API. Other filesystems still require disk commits.
    if (statfsSync(memoryDirectory).type === 0x01021994) {
      accessSync(memoryDirectory, constants.W_OK | constants.X_OK);
      return memoryDirectory;
    }
  } catch {
    // The memory-backed directory can be absent or inaccessible on this host.
  }
  return tmpdir();
};
