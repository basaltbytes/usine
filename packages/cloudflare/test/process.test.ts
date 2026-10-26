import { describe, expect, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_HOME } from "../src/api/harness.ts";
import {
  PROCESS_SCRIPT,
  STOP_SCRIPT,
  commandOptions,
  exitCodeOf,
  pidOf,
  stoppedCount,
} from "../src/sandbox/process.ts";

interface Finished {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/**
 * Runs `PROCESS_SCRIPT` locally as the container would, with `input` on stdin. The platform passes
 * an exec only the image's `PATH` and the exec's `env`.
 */
const runProcess = (directory: string, command: string, input: string) => {
  const child = spawn("sh", ["-c", PROCESS_SCRIPT, "usine-process", directory, command], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...commandOptions("pipe").env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(input);
  return {
    child,
    finished: new Promise<Finished>((resolve) =>
      child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode })),
    ),
  };
};

const stop = (root: string) =>
  new Promise<string>((resolve) => {
    const child = spawn("bash", ["-c", STOP_SCRIPT, "usine-stop", root]);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("close", () => resolve(stdout));
  });

/** Returns whether the process `pid` runs, which a zombie that waits to be reaped doesn't. */
const running = (pid: number) => {
  try {
    return !/^\d+ \(.*\) [ZX]/s.test(readFileSync(`/proc/${String(pid)}/stat`, "utf8"));
  } catch {
    return false;
  }
};

const waitFor = async (path: string) => {
  for (let tries = 0; tries < 100 && !existsSync(path); tries++)
    await new Promise((resolve) => setTimeout(resolve, 50));
};

describe("sandbox process files", () => {
  it("passes stdin, output, and the exit code through, and records them in the process files", async () => {
    const root = mkdtempSync(join(tmpdir(), "usine-process-"));
    const directory = join(root, "a".repeat(32));
    const { finished } = runProcess(
      directory,
      'read line; echo "got $line"; echo oops >&2; exit 3',
      "hello\n",
    );
    const result = await finished;

    expect(result).toEqual({ stdout: "got hello\n", stderr: "oops\n", exitCode: 3 });
    expect(readFileSync(join(directory, "stdout"), "utf8")).toBe("got hello\n");
    expect(readFileSync(join(directory, "stderr"), "utf8")).toBe("oops\n");
    expect(exitCodeOf(readFileSync(join(directory, "exit"), "utf8"))).toEqual(
      expect.objectContaining({ value: 3 }),
    );
    expect(pidOf(readFileSync(join(directory, "pid"), "utf8"))._tag).toBe("Some");
    expect(existsSync(join(directory, "stdout.pipe"))).toBe(false);
  });

  it("gives the command the sandbox home, which the platform doesn't pass from the image", async () => {
    const root = mkdtempSync(join(tmpdir(), "usine-process-"));
    const { finished } = runProcess(join(root, "d".repeat(32)), 'printf %s "$HOME"', "");

    expect(await finished).toEqual({ stdout: SANDBOX_HOME, stderr: "", exitCode: 0 });
  });

  it("keeps copying output to the files after the stream that started the command closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "usine-process-"));
    const directory = join(root, "b".repeat(32));
    const { child } = runProcess(directory, "sleep 0.3; echo late; exit 0", "");
    // The exec stream drops: nothing reads the wrapper's stdout any more.
    child.stdout.destroy();
    await waitFor(join(directory, "exit"));

    expect(readFileSync(join(directory, "stdout"), "utf8")).toBe("late\n");
    expect(readFileSync(join(directory, "exit"), "utf8")).toBe("0");
  });

  it("stops every running command's session and counts them", async () => {
    const root = mkdtempSync(join(tmpdir(), "usine-process-"));
    const directory = join(root, "c".repeat(32));
    const { finished } = runProcess(directory, "sleep 30 & sleep 30; echo unreachable", "");
    await waitFor(join(directory, "pid"));

    const output = await stop(root);
    const result = await finished;

    expect(stoppedCount(output)).toEqual(expect.objectContaining({ value: 1 }));
    expect(result.stdout).toBe("");
    expect(existsSync(join(directory, "exit"))).toBe(true);
    expect(stoppedCount(await stop(root))).toEqual(expect.objectContaining({ value: 0 }));
  });

  it("stops what a command left running after it exited, in its session or in a new one", async () => {
    const root = mkdtempSync(join(tmpdir(), "usine-process-"));
    const directory = join(root, "e".repeat(32));
    const background = join(root, "background");
    const job = join(root, "job");
    const detached = join(root, "detached");
    // A background process, a job in its own process group, and a process in its own session.
    const { finished } = runProcess(
      directory,
      `sleep 30 >/dev/null 2>&1 & echo $! > "${background}"; ` +
        `bash -c 'set -m; sleep 30 >/dev/null 2>&1 & echo $! > "${job}"'; ` +
        `setsid sleep 30 >/dev/null 2>&1 & echo $! > "${detached}"`,
      "",
    );
    expect((await finished).exitCode).toBe(0);
    const left = [background, job, detached].map((file) => Number(readFileSync(file, "utf8")));
    expect(left.filter(running)).toEqual(left);

    expect(stoppedCount(await stop(root))).toEqual(expect.objectContaining({ value: 2 }));
    expect(left.filter(running)).toEqual([]);
    expect(stoppedCount(await stop(root))).toEqual(expect.objectContaining({ value: 0 }));
  });

  it("leaves a process that reuses an exited command's ID, or that another directory marks", async () => {
    const root = mkdtempSync(join(tmpdir(), "usine-process-"));
    const directory = join(root, "f".repeat(32));
    expect((await runProcess(directory, "exit 0", "").finished).exitCode).toBe(0);
    const reused = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const elsewhere = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, USINE_PROCESS: join(`${root}-other`, "g".repeat(32)) },
    });
    try {
      writeFileSync(join(directory, "pid"), String(reused.pid));

      expect(stoppedCount(await stop(root))).toEqual(expect.objectContaining({ value: 0 }));
      expect([reused.pid, elsewhere.pid].map(Number).filter(running)).toHaveLength(2);
    } finally {
      reused.kill("SIGKILL");
      elsewhere.kill("SIGKILL");
    }
  });
});
