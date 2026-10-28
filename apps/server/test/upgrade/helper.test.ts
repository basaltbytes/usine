import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpgradeRecord } from "@usine/core/upgrade";
import { Schema } from "effect";
import { assert, expect, it } from "vitest";

const helper = readFileSync(new URL("../../src/upgrade/helper.sh", import.meta.url), "utf8");

const run = (
  scenario: "good" | "bad-api" | "bad-install" | "bad-rollback" | "bad-stop",
  shutdown: "normal" | "exit-term" | "exit-kill" | "stuck" = "normal",
) => {
  const folder = mkdtempSync(join(tmpdir(), "usine-upgrade-helper-"));
  const command = (name: string, body: string) => {
    const path = join(folder, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o700);
  };
  try {
    command("sleep", "exit 0");
    command(
      "npm",
      `echo "$*" >> "$folder/commands"
if [ "$scenario" = bad-install ] && [ "$5" = @usine/server@2.0.0 ]; then exit 1; fi
if [ "$scenario" = bad-rollback ] && [ "$5" = @usine/server@1.0.0 ]; then exit 1; fi
echo "$5" > "$folder/installed"`,
    );
    command(
      "systemctl",
      `echo "$*" >> "$folder/commands"
if [ "$1" = stop ] && [ "$scenario" = bad-stop ]; then exit 1; fi
if [ "$1" = stop ]; then
  echo inactive > "$folder/state"
  rm -f "$folder/pid-read"
  if [ "$shutdown" != normal ]; then echo deactivating > "$folder/state"; fi
fi
if [ "$2" = --property=MainPID ]; then
  if [ "$shutdown" = normal ] || { [ "$shutdown" = exit-kill ] && [ ! -f "$folder/pid-read" ]; }; then
    echo 0
  else
    bash -c 'exit 0' &
    exited_pid=$!
    wait "$exited_pid"
    echo "$exited_pid"
    if [ "$shutdown" != stuck ]; then echo inactive > "$folder/state"; fi
  fi
  touch "$folder/pid-read"
fi
if [ "$1" = start ]; then echo active > "$folder/state"; fi
if [ "$2" = --property=ActiveState ]; then cat "$folder/state"; fi`,
    );
    command(
      "curl",
      `installed=$(cat "$folder/installed")
if [ "$installed" = @usine/server@2.0.0 ] && { [ "$scenario" = bad-api ] || [ "$scenario" = bad-rollback ]; }; then exit 1; fi
printf '"%s"' "\${installed#@usine/server@}"`,
    );
    const script = join(folder, "run.sh");
    writeFileSync(
      script,
      `folder='${folder}'\nprevious=1.0.0\ntarget=2.0.0\nprefix='/opt/custom prefix'\nunit=usine.service\nport=7331\n${helper}`,
    );
    let failed = false;
    try {
      execFileSync("bash", [script], {
        env: { ...process.env, PATH: `${folder}:${process.env.PATH}`, folder, scenario, shutdown },
        stdio: "pipe",
      });
    } catch {
      failed = true;
    }
    return {
      failed,
      record: Schema.decodeUnknownSync(Schema.fromJsonString(UpgradeRecord))(
        readFileSync(join(folder, "result.json"), "utf8"),
      ),
      commands: readFileSync(join(folder, "commands"), "utf8"),
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

it("marks a version good only after its API answers, using the original npm prefix", () => {
  const result = run("good");
  expect(result.failed).toBe(false);
  expect(result.record.status).toBe("good");
  expect(result.commands).toContain(
    "install --global --prefix /opt/custom prefix @usine/server@2.0.0",
  );
  expect(result.commands).not.toContain("@usine/server@1.0.0");
});

it.each(["bad-api", "bad-install"] as const)(
  "reinstalls and starts the previous version after %s",
  (scenario) => {
    const result = run(scenario);
    expect(result.failed).toBe(false);
    assert(result.record.status === "rolled-back");
    expect(result.record.reason).not.toBe("");
    expect(result.commands).toContain("@usine/server@1.0.0");
  },
);

it("records a failed rollback and leaves the previous version in the recovery record", () => {
  const result = run("bad-rollback");
  expect(result.failed).toBe(true);
  expect(result.record.status).toBe("failed");
  expect(result.record.previous).toBe("1.0.0");
});

it("does not replace packages when systemd cannot stop the server", () => {
  const result = run("bad-stop");
  expect(result.failed).toBe(true);
  expect(result.commands).not.toContain("install");
});

it.each(["exit-term", "exit-kill"] as const)(
  "finishes upgrades and rollback when the server disappears before %s",
  (shutdown) => {
    const upgraded = run("good", shutdown);
    expect(upgraded.failed).toBe(false);
    expect(upgraded.record.status).toBe("good");
    const recovered = run("bad-api", shutdown);
    expect(recovered.failed).toBe(false);
    expect(recovered.record.status).toBe("rolled-back");
    expect(recovered.commands).toContain("@usine/server@1.0.0");
  },
);

it("does not install after failed signals when the unit remains deactivating", () => {
  const result = run("good", "stuck");
  expect(result.failed).toBe(true);
  expect(result.record.status).toBe("failed");
  expect(result.commands).not.toContain("install");
});
