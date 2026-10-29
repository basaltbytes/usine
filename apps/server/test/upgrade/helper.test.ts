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
  mkdirSync(folder);
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
if [ "$5" = @usine/server@2.0.0 ]; then
  count=0
  if [ -f "$folder/installs" ]; then count=$(cat "$folder/installs"); fi
  count=$((count + 1))
  echo "$count" > "$folder/installs"
  case "$scenario" in
    bad-install) echo 'npm error code EACCES' >&2; exit 1;;
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
if [ "$1" = start ]; then
  echo active > "$folder/state"
  printf '%043d' "$(cat "$folder/installed" | tr -cd '0-9')" > "$folder/../admin-token"
fi
if [ "$2" = --property=ActiveState ]; then cat "$folder/state"; fi`,
    );
    command(
      "curl",
      `read -r authorization
[ "$authorization" = "Authorization: Bearer $(< "$folder/../admin-token")" ] || exit 1
installed=$(cat "$folder/installed")
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
    rmSync(root, { recursive: true, force: true });
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
    expect(result.record.failureStage).toBe(
      scenario === "bad-install" ? "install" : "health-check",
    );
    expect(result.commands.match(/@usine\/server@2\.0\.0/gu)).toHaveLength(1);
    expect(result.commands).not.toContain("sleep 60");
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
  "rolls back with an install failure after exhausting registry retries for %s",
  (scenario) => {
    const result = run(scenario);
    expect(result.failed).toBe(false);
    assert(result.record.status === "rolled-back");
    expect(result.record.failureStage).toBe("install");
    expect(result.commands.match(/@usine\/server@2\.0\.0/gu)).toHaveLength(3);
    expect(result.commands.match(/sleep 60/gu)).toHaveLength(2);
    expect(result.commands).toContain("@usine/server@1.0.0");
  },
);

it("authenticates health checks with the current token after upgrade and rollback starts", async () => {
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
        const server = createServer(async (request, response) => {
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
          `${helper.slice(0, helper.indexOf("# The lock"))}
folder=$1
port=$2
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
        assert.notInclude(output.stdout + output.stderr, localSecret);
        assert.notInclude(output.stdout + output.stderr, Redacted.value(session.secret));
      }).pipe(Effect.scoped),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
