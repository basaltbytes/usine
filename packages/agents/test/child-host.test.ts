import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHILD_KILL_SCRIPT,
  childPidFile,
  type HostInvocation,
  RemoteShell,
  sshArguments,
} from "../src/child-host/child-host.ts";

const host = new RemoteShell({
  ssh: { command: "ssh", args: ["-o", "BatchMode=yes"] },
  sshEnvironment: {},
  destination: "worker.exe.xyz",
});

/** The one remote command line the SSH client carries after `--`. */
const remoteLine = (invocation: HostInvocation): string => {
  const [option, value, destination, separator, line, ...rest] = sshArguments(host, invocation);
  assert.deepStrictEqual(
    [option, value, destination, separator, rest],
    ["-o", "BatchMode=yes", "worker.exe.xyz", "--", []],
  );
  assert(line !== undefined);
  return line;
};

describe("remote shell commands", () => {
  it("keeps a plain command a quoted exec", () => {
    assert.strictEqual(
      remoteLine({ command: "git", args: ["log", "it's"] }),
      `exec 'git' 'log' 'it'"'"'s'`,
    );
  });

  it("runs in its directory with exported variables and records its pid only while it runs", () => {
    const worktree = mkdtempSync(join(tmpdir(), "usine-remote-shell-"));
    const pidFile = childPidFile(worktree, AgentSessionId.make("parent:attempt/1:child:3"));
    assert.strictEqual(pidFile, `${worktree}.child-3.pid`);
    const line = remoteLine({
      cwd: worktree,
      environment: { GREETING: "it's $HOME", SKIPPED: undefined },
      pidFile,
      command: "sh",
      args: [
        "-c",
        'printf "%s|%s|%s|%s" "$PWD" "$GREETING" "$(cat "$1")" "$$" > seen',
        "sh",
        pidFile,
      ],
    });
    execFileSync("sh", ["-c", line]);
    const [cwd, greeting, recorded, pid] = readFileSync(join(worktree, "seen"), "utf8").split("|");
    assert.strictEqual(cwd, worktree);
    assert.strictEqual(greeting, "it's $HOME");
    assert.strictEqual(recorded, pid, "the pid file names the command itself");
    assert.strictEqual(existsSync(pidFile), false, "the pid file is gone once the command exits");
  });

  it("keeps the command's exit code", () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "usine-remote-shell-")), "child-1.pid");
    const line = remoteLine({ pidFile, command: "sh", args: ["-c", "exit 7"] });
    assert.strictEqual(spawnSync("sh", ["-c", line]).status, 7);
  });

  it("stops a running child through its pid file and leaves nothing to stop after", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "usine-remote-shell-"));
    const pidFile = childPidFile(worktree, AgentSessionId.make("parent:attempt/1:child:1"));
    const child = spawn("sh", ["-c", remoteLine({ pidFile, command: "sleep", args: ["30"] })]);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "")
      await new Promise((resolve) => setTimeout(resolve, 10));
    const stop = () =>
      execFileSync("sh", ["-c", CHILD_KILL_SCRIPT, "sh", worktree], { encoding: "utf8" }).trim();
    assert.strictEqual(stop(), `${pidFile} stopped`);
    await exited;
    assert.strictEqual(existsSync(pidFile), false);
    assert.strictEqual(stop(), "no-children");
  });

  it("refuses a variable name the shell would not read as one", () => {
    assert.throws(
      () => remoteLine({ environment: { "A;B": "x" }, command: "true", args: [] }),
      /Cannot export A;B/u,
    );
  });
});
