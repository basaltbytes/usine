import { assert, describe, it } from "@effect/vitest";
import { AgentSessionId } from "@usine/core/agent/session";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childPidFile, remoteShellCommand } from "../src/child-host.ts";

describe("remote shell commands", () => {
  it("keeps a plain command a quoted exec", () => {
    assert.strictEqual(
      remoteShellCommand({ command: "git", args: ["log", "it's"] }),
      `exec 'git' 'log' 'it'"'"'s'`,
    );
  });

  it("runs in its directory with exported variables and records its pid only while it runs", () => {
    const worktree = mkdtempSync(join(tmpdir(), "usine-remote-shell-"));
    const pidFile = childPidFile(worktree, AgentSessionId.make("parent:attempt/1:child:3"));
    assert.strictEqual(pidFile, `${worktree}.child-3.pid`);
    const line = remoteShellCommand({
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
    const line = remoteShellCommand({ pidFile, command: "sh", args: ["-c", "exit 7"] });
    assert.strictEqual(spawnSync("sh", ["-c", line]).status, 7);
  });

  it("refuses a variable name the shell would not read as one", () => {
    assert.throws(
      () => remoteShellCommand({ environment: { "A;B": "x" }, command: "true", args: [] }),
      /Cannot export A;B/u,
    );
  });
});
