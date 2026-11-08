// The worker relay journals frames using native Node IO and timers.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics asyncFunction:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalJson:off
// @effect-diagnostics processEnv:off
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { pipeline, Transform } from "node:stream";
import { hasCode, type OwnerFiles } from "./files.ts";
import { ownerProgram, type Launch, type WorkerSources } from "./program.ts";
import { checkpoint, environment, inputFrame, outputFrame, relayFrame } from "./protocol.ts";

/** Passes only newline-terminated input; an unterminated final line is dropped at EOF. */
const terminatedLines = () => {
  let partial: Buffer[] = [];
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const end = chunk.lastIndexOf(10) + 1;
      if (end === 0) {
        partial.push(chunk);
        callback();
        return;
      }
      const complete = Buffer.concat([...partial, chunk.subarray(0, end)]);
      partial = [chunk.subarray(end)];
      callback(null, complete);
    },
  });
};

export const relay = async (files: OwnerFiles, launch: Launch, sources: WorkerSources) => {
  // A stdin error rejects the line iterator, so the pipeline callback has nothing to report.
  const stdin = pipeline(process.stdin, terminatedLines(), () => {});
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  const input = lines[Symbol.asyncIterator]();
  const first = await input.next();
  if (first.done === true) throw new Error("Missing child process environment");
  const exported = environment(first.value);
  const environmentHash = createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(exported)
          .sort()
          .map((key) => [key, exported[key]]),
      ),
    )
    .digest("hex");
  if (launch.mode === "replace") {
    await files.stopOwner();
    rmSync(files.root, { recursive: true, force: true });
  }
  if (!existsSync(files.root)) {
    await files.stopOwner();
    // Older installations used a second PID file for native session resume.
    await files.stopOwner(files.pidFile.replace(/\.pid$/u, "-resume.pid"));
  }
  if (
    launch.mode === "resume" &&
    existsSync(files.root) &&
    (!files.ownerAlive(files.pidFile) ||
      readFileSync(files.environmentFile, "utf8") !== environmentHash ||
      Date.now() - statSync(files.heartbeat).mtimeMs > launch.lease)
  ) {
    await files.stopOwner();
    rmSync(files.root, { recursive: true, force: true });
  }
  let retained = true;
  mkdirSync(dirname(files.root), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(files.root, { mode: 0o700 });
    retained = false;
    writeFileSync(files.environmentFile, environmentHash, { mode: 0o600 });
    writeFileSync(files.acknowledged, "0", { mode: 0o600 });
    writeFileSync(files.delivered, "0", { mode: 0o600 });
    writeFileSync(files.input, "", { mode: 0o600 });
    writeFileSync(files.output, "", { mode: 0o600 });
    writeFileSync(files.heartbeat, "", { mode: 0o600 });
    const supervisor = spawn(
      process.execPath,
      [
        "-e",
        ownerProgram(sources),
        "supervise",
        files.pidFile,
        "0",
        String(launch.lease),
        launch.command,
        ...launch.args,
      ],
      { detached: true, stdio: "ignore", env: { ...process.env, ...exported } },
    );
    supervisor.unref();
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const saved =
    launch.mode === "resume" && retained
      ? checkpoint(readFileSync(files.delivered, "utf8"))
      : { offset: launch.cursor, skip: 0 };
  let offset = saved.offset;
  let skip = saved.skip;
  const attachedAt = new Date();
  utimesSync(files.heartbeat, attachedAt, attachedAt);
  let pending: Buffer = Buffer.alloc(0);
  let ending = false;
  let waits = 0;
  let announced = false;
  const timer = setInterval(() => {
    if (!existsSync(files.ready)) {
      if (++waits > 400) process.exit(1);
      return;
    }
    if (!announced) {
      announced = true;
      const sequence = readFileSync(files.input, "utf8")
        .split("\n")
        .filter(Boolean)
        .reduce(
          (highest, line) => Math.max(highest, inputFrame(line).sequence),
          Number(readFileSync(files.acknowledged, "utf8")),
        );
      process.stdout.write(
        JSON.stringify({ ready: true, offset, skip, sequence, retained }) + "\n",
      );
    }
    const fd = openSync(files.output, "r");
    const data = Buffer.alloc(65536);
    const length = readSync(fd, data, 0, data.length, offset + pending.length);
    closeSync(fd);
    pending = Buffer.concat([pending, data.subarray(0, length)]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const frame = outputFrame(pending.subarray(0, end).toString());
      if ("stdout" in frame && skip > 0) {
        frame.stdout = Buffer.from(frame.stdout, "base64").subarray(skip).toString("base64");
        skip = 0;
      }
      offset += end + 1;
      pending = pending.subarray(end + 1);
      process.stdout.write(JSON.stringify({ ...frame, offset }) + "\n");
      if ("exitCode" in frame) ending = true;
    }
    if (!ending && !files.ownerAlive(files.pidFile)) {
      files.append(
        existsSync(files.exitFile)
          ? outputFrame(readFileSync(files.exitFile, "utf8"))
          : {
              exitCode: 1,
              stderrTail:
                "Child process owner disappeared without recording an exit; the worker may have restarted",
            },
      );
      rmSync(files.pidFile, { force: true });
      return;
    }
    if (ending) {
      clearInterval(timer);
      stdin.destroy();
      process.exitCode = 0;
    }
  }, 25);
  try {
    for await (const line of input) {
      const frame = relayFrame(line);
      if ("heartbeat" in frame) {
        const now = new Date();
        utimesSync(files.heartbeat, now, now);
        writeFileSync(files.delivered, JSON.stringify({ offset: frame.offset, skip: frame.skip }));
        if (frame.checkpoint)
          process.stdout.write(JSON.stringify({ checkpoint: true, offset: frame.offset }) + "\n");
      } else appendFileSync(files.input, line + "\n");
    }
  } finally {
    clearInterval(timer);
    stdin.destroy();
  }
};
