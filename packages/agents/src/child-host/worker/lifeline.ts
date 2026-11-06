// This entry point owns the harness process group through a native pipe and signal handlers.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalJson:off
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { constants } from "node:os";
import { signal } from "./files.ts";

const main = () => {
  const [pidFile, exitFile, command, ...args] = process.argv.slice(1);
  if (command === undefined) throw new Error("Missing child process command");
  const child = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  if (pidFile !== undefined && pidFile !== "")
    writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stderrTail: Buffer = Buffer.alloc(0);
  const diagnostic = (data: Buffer) => {
    stderrTail = Buffer.concat([stderrTail, data]).subarray(-8192);
  };
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  const signalChild = (name: NodeJS.Signals) => {
    if (child.pid !== undefined) signal(-child.pid, name);
  };
  const stop = () => {
    signalChild("SIGTERM");
    timer ??= setTimeout(() => signalChild("SIGKILL"), 5000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  const lifeline = new Socket({ fd: 3, readable: true, writable: false });
  lifeline.on("end", stop);
  lifeline.resume();
  process.stdin.pipe(child.stdin);
  child.stdin.on("error", () => {});
  child.stdout.pipe(process.stdout);
  child.stderr.on("data", diagnostic);
  child.stderr.pipe(process.stderr);
  child.on("error", (error) => {
    diagnostic(Buffer.from(error.message));
    process.stderr.write(error.message);
  });
  child.on("exit", () => signalChild("SIGKILL"));
  child.on("close", (code, sig) => {
    clearTimeout(timer);
    const exitCode =
      code === null ? (sig !== null ? 128 + (constants.signals[sig] ?? 0) : 1) : code;
    if (exitFile !== undefined && exitFile !== "")
      writeFileSync(exitFile, JSON.stringify({ exitCode, stderrTail: stderrTail.toString() }), {
        mode: 0o600,
      });
    if (pidFile !== undefined && pidFile !== "") rmSync(pidFile, { force: true });
    process.exit(exitCode);
  });
};

main();
