import { jsonKey } from "@usine/core/json-key";
import { DateTime, Effect, Layer, Redacted, Schema } from "effect";
// The test fixture uses native subprocess handles and synchronous process operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  // The synchronous fixture filesystem has no Effect FileSystem equivalent.
  // @effect-diagnostics-next-line nodeBuiltinImport:off
} from "node:fs";
import {
  createServer, // The Node server adapter requires native HTTP server and connection types.
  // @effect-diagnostics-next-line nodeBuiltinImport:off
} from "node:http";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
import { UpgradeRecord } from "@usine/core/upgrade";

import { HttpRouter, HttpServerResponse } from "effect/http";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { authFixture, localSecret } from "../auth/fixture.ts";
import { assert, expect, it } from "@effect/vitest";

const helper = readFileSync(new URL("../../src/upgrade/helper.sh", import.meta.url), "utf8");

const run = (
  scenario:
    | "good"
    | "retention"
    | "external-retention"
    | "external-low-space"
    | "external-instance-low-space"
    | "failed-retention"
    | "failed-prune"
    | "clock-skew-retention"
    | "low-space"
    | "invalid-retention"
    | "bad-api"
    | "bad-install"
    | "unchanged-install"
    | "unchanged-unhealthy"
    | "previous-rollback"
    | "missing-rollback"
    | "invalid-rollback"
    | "other-rollback"
    | "bad-rollback"
    | "bad-stop"
    | "transient-target"
    | "transient-404"
    | "missing-target"
    | "missing-404"
    | "migrated-api"
    | "migrated-external"
    | "migrated-good"
    | "migrated-startup-exit"
    | "migrated-startup-wait"
    | "migrated-startup-deadline"
    | "migrated-no-durable"
    | "bad-backup"
    | "missing-backup"
    | "missing-durable-backup",
  shutdown: "normal" | "exit-term" | "exit-kill" | "stuck" = "normal",
) => {
  const root = mkdtempSync(join(sqliteTempDirectory(), "usine-upgrade-helper-"));
  const executables = mkdtempSync(join(tmpdir(), "usine-upgrade-commands-"));
  const storage = join(root, ".usine");
  const folder = join(storage, "upgrade");
  const externalBackups =
    scenario === "external-retention" ||
    scenario === "external-low-space" ||
    scenario === "external-instance-low-space" ||
    scenario === "migrated-external";
  const backupRoot = externalBackups ? join(executables, 'external backup "folder"') : folder;
  const prefix = join(root, "custom prefix");
  const packageFolder = join(prefix, "lib/node_modules/@usine/server");
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(packageFolder, "dist"), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL("../../dist/main.js", import.meta.url)),
    join(packageFolder, "dist/main.js"),
  );
  writeFileSync(join(packageFolder, "package.json"), jsonKey({ version: "1.0.0" }));
  writeFileSync(join(folder, "installed"), "@usine/server@1.0.0");
  writeFileSync(join(folder, "running"), "@usine/server@1.0.0");
  writeFileSync(join(folder, "commands"), "");
  const command = (name: string, body: string) => {
    const path = join(executables, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o700);
  };
  const query = (file: string, sql: string) => {
    const database = new DatabaseSync(file);
    try {
      return database.prepare(sql).all();
    } finally {
      database.close();
    }
  };
  const runtime = new DatabaseSync(join(storage, "runtime.sqlite"));
  runtime.exec("CREATE TABLE configuration (kind TEXT, value TEXT)");
  runtime.exec("INSERT INTO configuration VALUES ('settings', 'before')");
  runtime.close();
  if (scenario !== "migrated-no-durable") {
    const durable = new DatabaseSync(join(storage, "durable.sqlite"));
    durable.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('before')");
    durable.close();
  }
  if (scenario === "bad-backup") writeFileSync(join(storage, "runtime.sqlite"), "not SQLite");
  try {
    const databaseBytes = ["runtime.sqlite", "durable.sqlite"].reduce(
      (total, database) =>
        total + (existsSync(join(storage, database)) ? statSync(join(storage, database)).size : 0),
      0,
    );
    if (scenario === "low-space") {
      command("df", `printf 'Avail\\n${databaseBytes * 2 - 1}\\n'`);
    }
    if (externalBackups) {
      command(
        "df",
        `available=${databaseBytes * 2}
if { [ "$scenario" = external-low-space ] && [ "\${!#}" != "$folder" ]; } ||
   { [ "$scenario" = external-instance-low-space ] && [ "\${!#}" = "$folder" ]; }; then
  available=$((available-1))
fi
printf 'Avail\\n%s\\n' "$available"`,
      );
    }
    if (scenario === "retention" || scenario === "external-retention") {
      mkdirSync(backupRoot, { recursive: true });
      mkdirSync(join(backupRoot, "operator-files"));
      writeFileSync(join(backupRoot, "backup.notes"), "keep");
    }
    if (
      scenario === "failed-retention" ||
      scenario === "clock-skew-retention" ||
      scenario === "failed-prune"
    ) {
      for (let backup = 0; backup < 3; backup++) {
        const old = join(backupRoot, `backup.old0000${backup}`);
        mkdirSync(old);
        const modified = DateTime.toDate(
          DateTime.makeUnsafe({ year: 2100, month: 1, day: backup + 1 }),
        );
        utimesSync(old, modified, modified);
      }
    }
    if (scenario === "failed-prune") {
      command("rm", 'if [[ "$*" = *backup.* ]]; then exit 1; fi\nexec /bin/rm "$@"');
    }
    command("sleep", 'echo "sleep $*" >> "$folder/commands"');
    command(
      "npm",
      `echo "$*" >> "$folder/commands"
manifest="$4/lib/node_modules/@usine/server/package.json"
if [ "$5" = @usine/server@2.0.0 ]; then
  count=0
  if [ -f "$folder/installs" ]; then count=$(cat "$folder/installs"); fi
  count=$((count + 1))
  echo "$count" > "$folder/installs"
  case "$scenario" in
    bad-install) rm "$manifest"; echo 'npm error code EACCES' >&2; exit 1;;
    unchanged-install|unchanged-unhealthy) echo 'npm error code EACCES' >&2; exit 1;;
    transient-target|transient-404|missing-target|missing-404)
      if [ "$count" -lt 3 ] || [[ "$scenario" = missing-* ]]; then
        case "$scenario" in
          *target) echo 'npm error code ETARGET' >&2;;
          *404) echo 'npm ERR! code E404' >&2;;
        esac
        exit 1
      fi;;
  esac
fi
if [ "$5" = @usine/server@1.0.0 ]; then
  case "$scenario" in
    bad-rollback) exit 1;;
    missing-rollback) rm "$manifest"; exit 1;;
    invalid-rollback) echo '{' > "$manifest"; exit 1;;
    other-rollback) echo '{"version":"0.9.0"}' > "$manifest"; exit 1;;
  esac
fi
echo "$5" > "$folder/installed"
printf '{"version":"%s"}' "\${5#@usine/server@}" > "$manifest"
if [ "$scenario" = previous-rollback ] && [ "$5" = @usine/server@1.0.0 ]; then exit 1; fi`,
    );
    command(
      "systemctl",
      `echo "$*" >> "$folder/commands"
if [ "$1" = stop ] && [ "$scenario" = bad-stop ]; then exit 1; fi
if [ "$1" = stop ]; then
  echo inactive > "$folder/state"
  : > "$folder/running"
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
if [ "$1" = start ]; then
  echo active > "$folder/state"
  cp "$folder/installed" "$folder/running"
  printf '%043d' "$(cat "$folder/installed" | tr -cd '0-9')" > "$folder/../admin-token"
  if [ "$(cat "$folder/installed")" = @usine/server@2.0.0 ]; then
    case "$scenario" in
      migrated-*|missing-*backup) node "$folder/database.cjs" migrate;;
    esac
    if [ "$scenario" = missing-backup ]; then rm -f "$folder"/backup.*/runtime.sqlite; fi
    if [ "$scenario" = missing-durable-backup ]; then rm -f "$folder"/backup.*/runtime.durable.sqlite; fi
  fi
fi
if [ "$2" = --property=ActiveState ]; then cat "$folder/state"; fi`,
    );
    command(
      "curl",
      `url=\${!#}
echo "curl $url" >> "$folder/commands"
installed=$(cat "$folder/installed")
if [[ "$url" = */api/ready ]]; then
  if [ "$installed" = @usine/server@2.0.0 ]; then
    case "$scenario" in
      migrated-startup-exit)
        echo failed > "$folder/state"
        : > "$folder/running"
        printf '503'; exit 0;;
      migrated-startup-deadline) printf '503'; exit 0;;
      migrated-startup-wait)
        if [ ! -f "$folder/readiness-checked" ]; then
          touch "$folder/readiness-checked"
          printf '503'; exit 0
        fi;;
    esac
  fi
  printf '200'
  exit 0
fi
read -r authorization
[ "$authorization" = "Authorization: Bearer $(< "$folder/../admin-token")" ] || exit 1
if [ "$scenario" = unchanged-unhealthy ]; then exit 1; fi
if [ "$installed" = @usine/server@2.0.0 ]; then
  case "$scenario" in bad-api|failed-retention|*-rollback|migrated-api|migrated-external|migrated-no-durable|missing-*backup) exit 1;; esac
else
  node "$folder/database.cjs" read || exit 1
fi
printf '"%s"' "\${installed#@usine/server@}"`,
    );
    writeFileSync(
      join(folder, "database.cjs"),
      `const { DatabaseSync } = require("node:sqlite");
const { existsSync, writeFileSync } = require("node:fs");
const folder = process.env.folder;
const runtime = new DatabaseSync(folder + "/../runtime.sqlite");
if (process.argv[2] === "migrate") {
  runtime.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  runtime.exec("INSERT INTO configuration VALUES ('binding', 'new')");
  const durable = new DatabaseSync(folder + "/../durable.sqlite");
  durable.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  durable.exec("CREATE TABLE IF NOT EXISTS evidence (value TEXT)");
  durable.exec("DELETE FROM evidence; INSERT INTO evidence VALUES ('new')");
  durable.exec("ALTER TABLE evidence ADD COLUMN migrated TEXT");
  writeFileSync(folder + "/migrated", "binding");
  process.exit(0);
}
if (runtime.prepare("SELECT kind FROM configuration WHERE kind != 'settings'").all().length) {
  process.exit(1);
}
runtime.close();
if (existsSync(folder + "/../durable.sqlite")) {
  const durable = new DatabaseSync(folder + "/../durable.sqlite");
  if (durable.prepare("PRAGMA table_info(evidence)").all().length !== 1) process.exit(1);
  durable.close();
}`,
    );
    const script = join(folder, "run.sh");
    writeFileSync(
      script,
      `folder='${folder}'\nprevious=1.0.0\ntarget=2.0.0\nprefix='${prefix}'\nunit=usine.service\nport=7331
unset SECONDS
SECONDS=0
sleep() { command sleep "$@"; SECONDS=$((SECONDS+$1)); }
${helper}`,
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      // Native command fixtures and test registration inspect the host environment synchronously.
      // @effect-diagnostics-next-line processEnv:off
      PATH: `${executables}:${process.env.PATH}`,
      folder,
      scenario,
      shutdown,
    };
    if (externalBackups) {
      environment.USINE_UPGRADE_BACKUP_DIR = `${backupRoot}/`;
      environment.USINE_UPGRADE_BACKUP_KEEP = "2";
    }
    if (scenario === "invalid-retention") environment.USINE_UPGRADE_BACKUP_KEEP = "0";
    const execute = () => {
      const result = spawnSync("bash", [script], {
        cwd: root,
        env: environment,
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.ifError(result.error);
      return result;
    };
    const snapshots = () =>
      readdirSync(backupRoot).filter((name) => /^backup\.[A-Za-z0-9]{8}$/u.test(name));
    const created: string[] = [];
    let result = execute();
    if (scenario === "retention" || scenario === "external-retention") {
      for (let upgrade = 0; upgrade < 4; upgrade++) {
        if (upgrade > 0) result = execute();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const current = result.stdout.match(/snapshot=(.*)/u)?.[1];
        assert(current !== undefined);
        created.push(current);
        const modified = DateTime.toDate(
          DateTime.makeUnsafe({ year: 2020, month: 1, day: upgrade + 1 }),
        );
        utimesSync(current, modified, modified);
      }
    }
    const retained = snapshots().map((name) => join(backupRoot, name));
    const snapshotPath = retained[0];
    return {
      failed: result.status !== 0,
      output: result.stdout + result.stderr,
      prefix,
      retained,
      databaseBytes,
      current: result.stdout.match(/upgrade backup previous=.*snapshot=(.*)/u)?.[1],
      created,
      operatorFiles: existsSync(join(backupRoot, "operator-files")),
      notes: existsSync(join(backupRoot, "backup.notes")),
      migrated: existsSync(join(folder, "migrated")),
      configuration:
        scenario === "bad-backup"
          ? []
          : query(join(storage, "runtime.sqlite"), "SELECT * FROM configuration ORDER BY kind"),
      durable: existsSync(join(storage, "durable.sqlite"))
        ? query(join(storage, "durable.sqlite"), "SELECT * FROM evidence")
        : [],
      snapshot:
        snapshotPath !== undefined && existsSync(join(snapshotPath, "runtime.sqlite"))
          ? {
              mode: statSync(join(snapshotPath, "runtime.sqlite")).mode & 0o777,
              configuration: query(
                join(snapshotPath, "runtime.sqlite"),
                "SELECT * FROM configuration",
              ),
            }
          : undefined,
      running: readFileSync(join(folder, "running"), "utf8").trim(),
      // The synchronous upgrade fixture returns the recorded result with its process output.
      // @effect-diagnostics-next-line schemaSync:off
      record: Schema.decodeSync(Schema.fromJsonString(UpgradeRecord))(
        readFileSync(join(folder, "result.json"), "utf8"),
      ),
      commands: readFileSync(join(folder, "commands"), "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(executables, { recursive: true, force: true });
  }
};

const slowCli = { timeout: 30_000 };

it.each(["retention", "external-retention"] as const)(
  "keeps the newest backups after four successful upgrades: %s",
  slowCli,
  (scenario) => {
    const result = run(scenario);
    expect(result.record.status).toBe("good");
    expect([...result.retained].sort()).toEqual(
      result.created.slice(scenario === "retention" ? -3 : -2).sort(),
    );
    expect(result.operatorFiles).toBe(true);
    expect(result.notes).toBe(true);
    expect(result.snapshot?.mode).toBe(0o600);
  },
);

it.each([
  "low-space",
  "external-low-space",
  "external-instance-low-space",
  "invalid-retention",
] as const)(
  "records a failure without stopping or replacing the server: %s",
  slowCli,
  (scenario) => {
    const result = run(scenario);
    expect(result.failed).toBe(true);
    assert(result.record.status === "failed");
    expect(result.record.reason).toContain(
      scenario === "invalid-retention" ? "BACKUP_KEEP" : "space",
    );
    if (scenario !== "invalid-retention") {
      expect(result.output).toContain(`required_bytes=${result.databaseBytes * 2}`);
    }
    if (scenario === "low-space") expect(result.record.reason).toContain(".usine/upgrade");
    if (scenario === "external-low-space") {
      expect(result.record.reason).toContain('external backup "folder"');
    }
    if (scenario === "external-instance-low-space") {
      expect(result.record.reason).toContain(".usine/upgrade");
    }
    expect(result.retained).toEqual([]);
    expect(result.running).toBe("@usine/server@1.0.0");
    expect(result.commands).not.toContain("stop");
    expect(result.commands).not.toContain("install");
    expect(result.configuration).toEqual([{ kind: "settings", value: "before" }]);
    expect(result.durable).toEqual([{ value: "before" }]);
  },
);

it("records a healthy upgrade when an old backup cannot be removed", slowCli, () => {
  const result = run("failed-prune");
  expect(result.failed).toBe(false);
  expect(result.record.status).toBe("good");
  expect(result.running).toBe("@usine/server@2.0.0");
  expect(result.retained).toHaveLength(4);
  expect(result.retained).toContain(result.current);
  expect(result.output).toContain("status=failed; check the upgrade service journal");
});

it("retains every backup when an upgrade rolls back", slowCli, () => {
  const result = run("failed-retention");
  expect(result.record.status).toBe("rolled-back");
  expect(result.retained).toHaveLength(4);
  expect(result.retained).toContain(result.current);
});

it("keeps the current backup even when older backups have future timestamps", slowCli, () => {
  const result = run("clock-skew-retention");
  expect(result.record.status).toBe("good");
  expect(result.retained).toHaveLength(3);
  expect(result.retained).toContain(result.current);
  expect(result.retained.some((path) => path.endsWith("backup.old00000"))).toBe(false);
});

it.each(["migrated-api", "migrated-external", "migrated-no-durable"] as const)(
  "restores the previous stores before its API answers after %s",
  slowCli,
  (scenario) => {
    const result = run(scenario);
    expect(result.migrated).toBe(true);
    expect(result.failed, result.output).toBe(false);
    expect(result.record.status).toBe("rolled-back");
    expect(result.running).toBe("@usine/server@1.0.0");
    expect(result.configuration).toEqual([{ kind: "settings", value: "before" }]);
    expect(result.durable).toEqual(scenario === "migrated-no-durable" ? [] : [{ value: "before" }]);
    expect(result.snapshot).toEqual({
      mode: 0o600,
      configuration: [{ kind: "settings", value: "before" }],
    });
  },
);

it.each(["migrated-startup-exit", "migrated-startup-deadline"] as const)(
  "restores the package and both databases when the version answers but readiness fails: %s",
  slowCli,
  (scenario) => {
    const result = run(scenario);
    expect(result.failed, result.output).toBe(false);
    expect(result.migrated).toBe(true);
    assert(result.record.status === "rolled-back");
    expect(result.record.failureStage).toBe("health-check");
    expect(result.running).toBe("@usine/server@1.0.0");
    expect(result.configuration).toEqual([{ kind: "settings", value: "before" }]);
    expect(result.durable).toEqual([{ value: "before" }]);
    expect(result.output).toContain(
      scenario === "migrated-startup-exit" ? "reason=service-stopped" : "reason=deadline-exceeded",
    );
    if (scenario === "migrated-startup-deadline") {
      const elapsed = Number(
        result.output.match(/reason=deadline-exceeded elapsed_seconds=(\d+)/u)?.[1],
      );
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(elapsed).toBeLessThan(183);
    }
  },
);

it("waits for recovery after the target version answers before recording good", slowCli, () => {
  const result = run("migrated-startup-wait");
  expect(result.failed, result.output).toBe(false);
  expect(result.record.status).toBe("good");
  expect(result.commands).toContain("sleep 3");
  expect(result.configuration).toContainEqual({ kind: "binding", value: "new" });
  expect(result.durable).toEqual([{ value: "new", migrated: null }]);
});

it("keeps migrated data and a private backup after a successful upgrade", slowCli, () => {
  const result = run("migrated-good");
  expect(result.failed, result.output).toBe(false);
  expect(result.record.status).toBe("good");
  expect(result.configuration).toContainEqual({ kind: "binding", value: "new" });
  expect(result.durable).toEqual([{ value: "new", migrated: null }]);
  expect(result.snapshot?.configuration).toEqual([{ kind: "settings", value: "before" }]);
});

it("leaves the running version untouched when a database backup fails", slowCli, () => {
  const result = run("bad-backup");
  expect(result.failed).toBe(true);
  assert(result.record.status === "failed");
  expect(result.record.reason).toContain("back up");
  expect(result.running).toBe("@usine/server@1.0.0");
  expect(result.commands).not.toContain("stop");
  expect(result.commands).not.toContain("install");
});

it.each(["missing-backup", "missing-durable-backup"] as const)(
  "leaves the service stopped with a database recovery error after %s",
  slowCli,
  (scenario) => {
    const result = run(scenario);
    expect(result.failed).toBe(true);
    assert(result.record.status === "failed");
    expect(result.record.reason).toContain("restore the databases");
    expect(result.running).toBe("");
  },
);

it("waits for 180 elapsed seconds when health requests fail immediately", slowCli, () => {
  const result = run("bad-api");
  expect(result.failed, result.output).toBe(false);
  const elapsed = Number(
    result.output.match(/reason=deadline-exceeded elapsed_seconds=(\d+)/u)?.[1],
  );
  expect(elapsed).toBeGreaterThanOrEqual(180);
  expect(elapsed).toBeLessThan(183);
  const retryDelays = (result.commands.match(/^sleep \d+$/gmu) ?? []).map((line) =>
    Number(line.slice(6)),
  );
  expect(retryDelays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(160);
});

it(
  "marks a version good only after startup recovery finishes, using the original npm prefix",
  slowCli,
  () => {
    const result = run("good");
    expect(result.failed).toBe(false);
    expect(result.record.status).toBe("good");
    expect(result.commands).toContain(
      `install --global --prefix ${result.prefix} @usine/server@2.0.0`,
    );
    expect(result.commands).not.toContain("@usine/server@1.0.0");
  },
);

it.each(["bad-api", "bad-install"] as const)(
  "reinstalls and starts the previous version after %s",
  slowCli,
  (scenario) => {
    const result = run(scenario);
    expect(result.failed).toBe(false);
    assert(result.record.status === "rolled-back");
    expect(result.record.reason).not.toBe("");
    expect(result.record.failureStage).toBe(
      scenario === "bad-install" ? "install" : "health-check",
    );
    expect(result.commands.match(/@usine\/server@2\.0\.0/gu)).toHaveLength(1);
    expect(result.commands).not.toContain("sleep 60");
    expect(result.commands).toContain("@usine/server@1.0.0");
    expect(result.running).toBe("@usine/server@1.0.0");
  },
);

it(
  "records a failed rollback and leaves the previous version in the recovery record",
  slowCli,
  () => {
    const result = run("bad-rollback");
    expect(result.failed).toBe(true);
    assert(result.record.status === "failed");
    expect(result.record.previous).toBe("1.0.0");
    expect(result.record.reason).not.toContain("reinstall the previous version");
    expect(result.running).toBe("");
  },
);

it(
  "restarts the unchanged previous version after a failed target install without reinstalling",
  slowCli,
  () => {
    const result = run("unchanged-install");
    expect(result.failed).toBe(true);
    assert(result.record.status === "failed");
    expect(result.record.reason).toBe("The package could not be installed.");
    expect(result.running).toBe("@usine/server@1.0.0");
    expect(result.commands).not.toContain("@usine/server@1.0.0");
  },
);

it(
  "starts the previous version when the rollback install fails with that version on disk",
  slowCli,
  () => {
    const result = run("previous-rollback");
    expect(result.failed).toBe(true);
    assert(result.record.status === "failed");
    expect(result.record.reason).toBe("The new server did not become ready within three minutes.");
    expect(result.commands).toContain("@usine/server@1.0.0");
    expect(result.running).toBe("@usine/server@1.0.0");
  },
);

it(
  "reports recovery failure when the unchanged previous version fails its health check",
  slowCli,
  () => {
    const result = run("unchanged-unhealthy");
    expect(result.failed).toBe(true);
    assert(result.record.status === "failed");
    expect(result.record.reason).toBe("Rollback failed. Check the upgrade service journal.");
    expect(result.running).toBe("");
  },
);

it.each(["missing-rollback", "invalid-rollback", "other-rollback"] as const)(
  "requests a manual reinstall when neither known version can be identified after %s",
  slowCli,
  (scenario) => {
    const result = run(scenario);
    expect(result.failed).toBe(true);
    assert(result.record.status === "failed");
    expect(result.record.reason).toContain("reinstall the previous version");
    expect(result.running).toBe("");
  },
);

it("does not replace packages when systemd cannot stop the server", slowCli, () => {
  const result = run("bad-stop");
  expect(result.failed).toBe(true);
  expect(result.commands).not.toContain("install");
});

it.each(["exit-term", "exit-kill"] as const)(
  "finishes upgrades and rollback when the server disappears before %s",
  slowCli,
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

it("does not install after failed signals when the unit remains deactivating", slowCli, () => {
  const result = run("good", "stuck");
  expect(result.failed).toBe(true);
  expect(result.record.status).toBe("failed");
  expect(result.commands).not.toContain("install");
});

it.each(["transient-target", "transient-404"] as const)(
  "installs after delayed registry propagation for %s without rollback",
  slowCli,
  (scenario) => {
    const result = run(scenario);
    expect(result.failed).toBe(false);
    expect(result.record.status).toBe("good");
    expect(result.commands.match(/@usine\/server@2\.0\.0/gu)).toHaveLength(3);
    expect(result.commands.match(/sleep 60/gu)).toHaveLength(2);
    expect(result.commands).not.toContain("@usine/server@1.0.0");
  },
);

it.each(["missing-target", "missing-404"] as const)(
  "restarts the unchanged previous version after exhausting registry retries for %s",
  slowCli,
  (scenario) => {
    const result = run(scenario);
    expect(result.failed).toBe(true);
    assert(result.record.status === "failed");
    expect(result.record.reason).toBe("The package could not be installed.");
    expect(result.running).toBe("@usine/server@1.0.0");
    expect(result.commands.match(/@usine\/server@2\.0\.0/gu)).toHaveLength(3);
    expect(result.commands.match(/sleep 60/gu)).toHaveLength(2);
    expect(result.commands).not.toContain("@usine/server@1.0.0");
  },
);

it.live.each(["legacy", "current"])("supports %s upgrade health checks", (generation) =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), "usine-upgrade-auth-"));
    const folder = join(root, "upgrade");
    mkdirSync(folder);
    try {
      yield* Effect.gen(function* () {
        const services = yield* authFixture();
        const started = yield* services.authentication.startWeb(false);
        const session = yield* services.authentication.finishWeb(
          Redacted.value(started.state),
          "fake",
        );
        const { guard } = authenticatedRoutes(services);
        const versions = ["2.0.0", "1.0.0"];
        const app = HttpRouter.toWebHandler(
          HttpRouter.add(
            "GET",
            "/api/version",
            Effect.sync(() => HttpServerResponse.jsonUnsafe(versions.shift())),
          ).pipe(
            Layer.merge(HttpRouter.add("GET", "/api/ready", HttpServerResponse.json({ ok: true }))),
            Layer.provide(guard.layer),
          ),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
        const statuses: Array<number> = [];
        const authorizations: Array<string | undefined> = [];
        // The native HTTP test adapter forwards a Promise-based Web handler.
        // @effect-diagnostics-next-line asyncFunction:off
        const server = createServer(async (request, response) => {
          authorizations.push(request.headers.authorization);
          const result = await app.handler(
            new Request(`http://localhost${request.url}`, {
              headers: { authorization: request.headers.authorization ?? "" },
            }),
          );
          statuses.push(result.status);
          response.writeHead(result.status).end(await result.text());
        });
        yield* Effect.callback<void>((resume) => {
          const resolve = (value: void) => resume(Effect.succeed(value));
          server.listen(0, "127.0.0.1", resolve);
        });
        yield* Effect.addFinalizer(() =>
          Effect.callback<void>((resume) => {
            const resolve = (value: void) => resume(Effect.succeed(value));
            const reject = (error: Error) => resume(Effect.die(error));
            server.close((error) => (error !== undefined ? reject(error) : resolve()));
          }),
        );
        const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Finite }))(
          server.address(),
        );
        const script = join(folder, "health.sh");
        writeFileSync(
          script,
          `${generation === "legacy" ? readFileSync(new URL("./legacy-health.sh", import.meta.url), "utf8") : helper.slice(0, helper.indexOf("# The lock"))}
set -eu
systemctl() { echo failed; }
folder=$1
port=$2
unit=usine.service
printf '%s' '${localSecret}' > "$folder/../admin-token"
healthy 2.0.0 ready
printf '%s' '${Redacted.value(session.secret)}' > "$folder/../admin-token"
healthy 1.0.0 version
`,
        );
        const output = yield* Effect.promise(() =>
          promisify(execFile)("bash", [script, folder, String(port)]),
        );
        assert.deepEqual(statuses, generation === "legacy" ? [200, 200] : [200, 200, 200]);
        assert.deepEqual(
          authorizations,
          generation === "legacy"
            ? [undefined, undefined]
            : [`Bearer ${localSecret}`, undefined, `Bearer ${Redacted.value(session.secret)}`],
        );
        assert.notInclude(output.stdout + output.stderr, localSecret);
        assert.notInclude(output.stdout + output.stderr, Redacted.value(session.secret));
      }).pipe(Effect.scoped);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }),
);
