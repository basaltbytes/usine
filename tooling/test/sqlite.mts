// The tmpfs probe requires statfsSync; Effect FileSystem has no filesystem-capacity API.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { accessSync, constants, statfsSync } from "node:fs";
import { tmpdir } from "node:os";

/** Selects writable tmpfs with at least `sizeHintBytes` free, or the OS temporary directory. */
export const sqliteTempDirectory = (
  memoryDirectory = "/dev/shm",
  sizeHintBytes = 16 * 1024 ** 2,
): string => {
  try {
    // TMPFS_MAGIC from Linux's statfs API. Other filesystems still require disk commits.
    const filesystem = statfsSync(memoryDirectory);
    if (filesystem.type === 0x01021994 && filesystem.bavail * filesystem.bsize >= sizeHintBytes) {
      accessSync(memoryDirectory, constants.W_OK | constants.X_OK);
      return memoryDirectory;
    }
  } catch {
    // The memory-backed directory can be absent or inaccessible on this host.
  }
  return tmpdir();
};
