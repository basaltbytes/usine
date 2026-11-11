// The worker owns native process handles, timers, and journals independently of the orchestrator.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { signal, type OwnerFiles } from "./files.ts";
import { inputFrame, outputFrame } from "./protocol.ts";
import type { Launch } from "./program.ts";

/**
 * Records `reason` as the harness exit, marks the owner ready so the relay reports it at once, and
 * exits. Exiting closes the lifeline pipe, which stops any harness already started.
 */
const abandon = (files: OwnerFiles, reason: string): never => {
  try {
    files.append({ exitCode: 1, stderrTail: reason });
    rmSync(files.pidFile, { force: true });
    writeFileSync(files.ready, "");
  } finally {
    process.exit(1);
  }
};

/** Starts the lifeline and relays its journals; throws if setup fails before the owner is ready. */
const start = (files: OwnerFiles, launch: Launch, lifeline: string) => {
  const identity = files.readIdentity(process.pid);
  if (identity === null) throw new Error("Could not identify the child process owner");
  writeFileSync(files.pidFile, String(process.pid), { mode: 0o600 });
  writeFileSync(files.identityFile(files.pidFile), identity, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    ["-e", lifeline, files.lifelinePid, files.exitFile, launch.command, ...launch.args],
    { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );
  if (child.pid !== undefined) {
    const childIdentity = files.readIdentity(child.pid);
    if (childIdentity === null) throw new Error("Could not identify the child process lifeline");
    writeFileSync(files.identityFile(files.lifelinePid), childIdentity, { mode: 0o600 });
  }
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (child.pid !== undefined) signal(-child.pid, "SIGTERM");
    killTimer = setTimeout(() => {
      if (child.pid !== undefined) signal(-child.pid, "SIGKILL");
    }, 6000);
  };
  process.on("SIGTERM", stop);
  process.on("SIGHUP", () => {});
  child.stdin.on("error", () => {});
  child.stdout.on("data", (data: Buffer) => files.append({ stdout: data.toString("base64") }));
  let stderrTail: Buffer = Buffer.alloc(0);
  child.stderr.on("data", (data: Buffer) => {
    stderrTail = Buffer.concat([stderrTail, data]).subarray(-8192);
  });
  child.on("error", (error) => {
    stderrTail = Buffer.from(error.message).subarray(-8192);
  });
  child.on("close", (code) => {
    clearTimeout(killTimer);
    clearInterval(timer);
    files.append(
      existsSync(files.exitFile)
        ? outputFrame(readFileSync(files.exitFile, "utf8"))
        : { exitCode: code === null ? 1 : code, stderrTail: stderrTail.toString() },
    );
    rmSync(files.pidFile, { force: true });
  });
  let offset = 0;
  let buffered: Buffer = Buffer.alloc(0);
  let sequence = 0;
  const timer = setInterval(() => {
    if (Date.now() - statSync(files.heartbeat).mtimeMs > launch.lease) stop();
    const fd = openSync(files.input, "r");
    const data = Buffer.alloc(65536);
    const length = readSync(fd, data, 0, data.length, offset);
    closeSync(fd);
    offset += length;
    buffered = Buffer.concat([buffered, data.subarray(0, length)]);
    let end;
    while ((end = buffered.indexOf(10)) >= 0) {
      const frame = inputFrame(buffered.subarray(0, end).toString());
      buffered = buffered.subarray(end + 1);
      if (frame.sequence <= sequence) {
        files.append({ ack: sequence });
        continue;
      }
      sequence = frame.sequence;
      writeFileSync(files.acknowledged, String(sequence));
      if ("eof" in frame) child.stdin.end();
      else if (!stopped) child.stdin.write(Buffer.from(frame.data, "base64"));
      files.append({ ack: sequence });
    }
  }, 25);
  writeFileSync(files.ready, "");
};

/** Supervises one harness; a setup failure becomes its exit record. */
export const supervise = (files: OwnerFiles, launch: Launch, lifeline: string) => {
  try {
    start(files, launch, lifeline);
  } catch (cause) {
    abandon(files, cause instanceof Error ? cause.message : String(cause));
  }
};
