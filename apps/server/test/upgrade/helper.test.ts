import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpgradeRecord } from "@usine/core/upgrade";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { authenticatedRoutes } from "../../src/auth/http.ts";
import { authFixture, localSecret } from "../auth/fixture.ts";
import { assert, expect, it } from "vitest";

const helper = readFileSync(new URL("../../src/upgrade/helper.sh", import.meta.url), "utf8");

const run = (
  scenario:
    | "good"
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
    | "missing-404",
  shutdown: "normal" | "exit-term" | "exit-kill" | "stuck" = "normal",
) => {
  const root = mkdtempSync(join(tmpdir(), "usine-upgrade-helper-"));
  const folder = join(root, "upgrade");
  const prefix = join(root, "custom prefix");
  const packageFolder = join(prefix, "lib/node_modules/@usine/server");
  mkdirSync(folder);
  mkdirSync(packageFolder, { recursive: true });
  writeFileSync(join(packageFolder, "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(folder, "installed"), "@usine/server@1.0.0");
  writeFileSync(join(folder, "running"), "@usine/server@1.0.0");
  const command = (name: string, body: string) => {
    const path = join(folder, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o700);
  };
  try {
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
fi
if [ "$2" = --property=ActiveState ]; then cat "$folder/state"; fi`,
    );
    command(
      "curl",
      `read -r authorization
[ "$authorization" = "Authorization: Bearer $(< "$folder/../admin-token")" ] || exit 1
installed=$(cat "$folder/installed")
if [ "$scenario" = unchanged-unhealthy ]; then exit 1; fi
if [ "$installed" = @usine/server@2.0.0 ]; then
  case "$scenario" in bad-api|*-rollback) exit 1;; esac
fi
printf '"%s"' "\${installed#@usine/server@}"`,
    );
    const script = join(folder, "run.sh");
    writeFileSync(
      script,
      `folder='${folder}'\nprevious=1.0.0\ntarget=2.0.0\nprefix='${prefix}'\nunit=usine.service\nport=7331\n${helper}`,
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
      prefix,
      running: readFileSync(join(folder, "running"), "utf8").trim(),
      record: Schema.decodeUnknownSync(Schema.fromJsonString(UpgradeRecord))(
        readFileSync(join(folder, "result.json"), "utf8"),
      ),
      commands: readFileSync(join(folder, "commands"), "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

it("marks a version good only after its API answers, using the original npm prefix", () => {
  const result = run("good");
  expect(result.failed).toBe(false);
  expect(result.record.status).toBe("good");
  expect(result.commands).toContain(
    `install --global --prefix ${result.prefix} @usine/server@2.0.0`,
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
    expect(result.record.failureStage).toBe(
      scenario === "bad-install" ? "install" : "health-check",
    );
    expect(result.commands.match(/@usine\/server@2\.0\.0/gu)).toHaveLength(1);
    expect(result.commands).not.toContain("sleep 60");
    expect(result.commands).toContain("@usine/server@1.0.0");
    expect(result.running).toBe("@usine/server@1.0.0");
  },
);

it("records a failed rollback and leaves the previous version in the recovery record", () => {
  const result = run("bad-rollback");
  expect(result.failed).toBe(true);
  assert(result.record.status === "failed");
  expect(result.record.previous).toBe("1.0.0");
  expect(result.record.reason).not.toContain("reinstall the previous version");
  expect(result.running).toBe("");
});

it("restarts the unchanged previous version after a failed target install without reinstalling", () => {
  const result = run("unchanged-install");
  expect(result.failed).toBe(true);
  assert(result.record.status === "failed");
  expect(result.record.reason).toBe("The package could not be installed.");
  expect(result.running).toBe("@usine/server@1.0.0");
  expect(result.commands).not.toContain("@usine/server@1.0.0");
});

it("starts the previous version when the rollback install fails with that version on disk", () => {
  const result = run("previous-rollback");
  expect(result.failed).toBe(true);
  assert(result.record.status === "failed");
  expect(result.record.reason).toBe(
    "The new server did not answer the operator API within three minutes.",
  );
  expect(result.commands).toContain("@usine/server@1.0.0");
  expect(result.running).toBe("@usine/server@1.0.0");
});

it("reports recovery failure when the unchanged previous version fails its health check", () => {
  const result = run("unchanged-unhealthy");
  expect(result.failed).toBe(true);
  assert(result.record.status === "failed");
  expect(result.record.reason).toBe("Rollback failed. Check the upgrade service journal.");
});

it.each(["missing-rollback", "invalid-rollback", "other-rollback"] as const)(
  "requests a manual reinstall when neither known version can be identified after %s",
  (scenario) => {
    const result = run(scenario);
    expect(result.failed).toBe(true);
    assert(result.record.status === "failed");
    expect(result.record.reason).toContain("reinstall the previous version");
    expect(result.running).toBe("");
  },
);

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

it.each(["transient-target", "transient-404"] as const)(
  "installs after delayed registry propagation for %s without rollback",
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

it.each(["legacy", "current"])("supports %s upgrade health checks", async (generation) => {
  const root = mkdtempSync(join(tmpdir(), "usine-upgrade-auth-"));
  const folder = join(root, "upgrade");
  mkdirSync(folder);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
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
          ).pipe(Layer.provide(guard.layer)),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
        const statuses: Array<number> = [];
        const authorizations: Array<string | undefined> = [];
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
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              ),
          ),
        );
        const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
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
healthy 2.0.0
printf '%s' '${Redacted.value(session.secret)}' > "$folder/../admin-token"
healthy 1.0.0
`,
        );
        const output = yield* Effect.promise(() =>
          promisify(execFile)("bash", [script, folder, String(port)]),
        );
        assert.deepEqual(statuses, [200, 200]);
        assert.deepEqual(
          authorizations,
          generation === "legacy"
            ? [undefined, undefined]
            : [`Bearer ${localSecret}`, `Bearer ${Redacted.value(session.secret)}`],
        );
        assert.notInclude(output.stdout + output.stderr, localSecret);
        assert.notInclude(output.stdout + output.stderr, Redacted.value(session.secret));
      }).pipe(Effect.scoped),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
