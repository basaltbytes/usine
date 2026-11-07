// Worker lifecycle operations use synchronous Node IO at the process boundary.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalJson:off
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isNativeError } from "node:util/types";
import type { OutputFrame } from "./protocol.ts";

export type IdentityReader = (pid: number) => string | null;

export const hasCode = (cause: unknown, code: string) =>
  isNativeError(cause) && "code" in cause && cause.code === code;

export const signal = (pid: number, name: NodeJS.Signals | 0) => {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    throw error;
  }
};

export const processIdentity: IdentityReader = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${pid}:${fields[19]}`;
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) return null;
    throw error;
  }
};

const readPid = (file: string) => {
  const pid = Number(readFileSync(file, "utf8"));
  if (!Number.isSafeInteger(pid) || pid === 0) throw new Error("Invalid child process PID");
  return pid;
};

export const ownerFiles = (pidFile: string, readIdentity: IdentityReader) => {
  const root = `${pidFile}.transport`;
  const lifelinePid = join(root, "process");
  const output = join(root, "output");
  const identityFile = (file: string) =>
    file === pidFile ? join(root, "identity") : `${file}.identity`;
  const ownerAlive = (file: string) => {
    if (!existsSync(file)) return false;
    const pid = readPid(file);
    if (!existsSync(root)) return signal(pid, 0);
    const identity = identityFile(file);
    return existsSync(identity) && readFileSync(identity, "utf8") === readIdentity(pid);
  };
  const stopOwner = async (file = pidFile): Promise<void> => {
    if (ownerAlive(file)) {
      const target = readPid(file);
      signal(target, "SIGTERM");
      for (let n = 0; ownerAlive(file); n++) {
        if (n === 240) signal(target, "SIGKILL");
        if (n === 480) throw new Error("Child process did not stop");
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    if (file === pidFile) await stopOwner(lifelinePid);
    rmSync(file, { force: true });
    rmSync(identityFile(file), { force: true });
  };
  return {
    pidFile,
    root,
    lifelinePid,
    output,
    identityFile,
    ownerAlive,
    stopOwner,
    readIdentity,
    input: join(root, "input"),
    ready: join(root, "ready"),
    heartbeat: join(root, "heartbeat"),
    acknowledged: join(root, "sequence"),
    delivered: join(root, "delivered"),
    exitFile: join(root, "exit"),
    environmentFile: join(root, "environment"),
    append: (frame: OutputFrame) => appendFileSync(output, JSON.stringify(frame) + "\n"),
  };
};

export type OwnerFiles = ReturnType<typeof ownerFiles>;
