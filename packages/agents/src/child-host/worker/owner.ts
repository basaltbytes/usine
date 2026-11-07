// This standalone Node entry point reports fatal worker failures through stderr and its exit code.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalJson:off
import { existsSync, rmSync } from "node:fs";
import { ownerFiles, processIdentity, type IdentityReader } from "./files.ts";
import { relay } from "./relay.ts";
import { supervise } from "./supervise.ts";

import { type Launch, type WorkerSources } from "./program.ts";

const main = async (sources: WorkerSources, readIdentity: IdentityReader) => {
  if (readIdentity === processIdentity && !existsSync("/proc/self/stat"))
    throw new Error("The child process owner requires Linux /proc");
  const [mode, pidFile, cursor, lease, command, ...args] = process.argv.slice(1);
  if (pidFile === undefined) throw new Error("Missing child process PID file");
  const files = ownerFiles(pidFile, readIdentity);
  if (mode === "stop") return files.stopOwner();
  if (mode === "remove") {
    if (files.ownerAlive(pidFile) || files.ownerAlive(files.lifelinePid)) {
      process.exitCode = 1;
      return;
    }
    rmSync(pidFile, { force: true });
    rmSync(files.root, { recursive: true, force: true });
    return;
  }
  if (mode !== "supervise" && mode !== "attach" && mode !== "replace" && mode !== "resume")
    throw new Error("Invalid child process owner mode");
  if (
    command === undefined ||
    !Number.isSafeInteger(Number(cursor)) ||
    !Number.isFinite(Number(lease))
  )
    throw new Error("Invalid child process launch arguments");
  const launch: Launch = {
    mode,
    cursor: Number(cursor),
    lease: Number(lease),
    command,
    args,
  };
  if (mode === "supervise") supervise(files, launch, sources.lifeline);
  else await relay(files, launch, sources);
};

export const run = (sources: WorkerSources, readIdentity: IdentityReader = processIdentity) => {
  main(sources, readIdentity).catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
};
