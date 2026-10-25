import { describe, expect, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROCESS_SCRIPT,
  STOP_SCRIPT,
  exitCodeOf,
  pidOf,
  stoppedCount,
} from "../src/sandbox/process.ts";

interface Finished {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/** Runs `PROCESS_SCRIPT` locally as the container would, with `input` on stdin. */
const runProcess = (directory: string, command: string, input: string) => {
  const child = spawn("sh", ["-c", PROCESS_SCRIPT, "usine-process", directory, command], {
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

  it("stops every running command's process group and counts them", async () => {
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
});
