import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { ReleaseVersion } from "@usine/core/upgrade";
import { UpgradeRequest } from "@usine/orchestrator/operator/http";
import { DateTime, Effect, Option, Ref } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, expect, it } from "vitest";
import { Port } from "../../src/cli.ts";
import { InstanceLaunch, InstanceRecord, ProcessId } from "../../src/instance/record.ts";
import { SystemdUnit } from "../../src/instance/systemd.ts";
import { makeUpgrades, UpgradeError } from "../../src/upgrade/control.ts";
import { systemUpgradePlatform } from "../../src/upgrade/platform.ts";

const platformAt = (folder: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* systemUpgradePlatform(
      InstanceDirectory.make(folder),
      new InstanceRecord({
        pid: ProcessId.make(4242),
        version: "1.0.0",
        startedAt: DateTime.nowUnsafe(),
        systemdUnit: Option.some(SystemdUnit.make("usine.service")),
        launch: new InstanceLaunch({
          node: process.execPath,
          nodeOptions: [],
          script: join(folder, "lib/node_modules/@usine/server/dist/main.js"),
          port: Port.make(7331),
          logLevel: "Info",
          allowVolatileInstance: false,
        }),
      }),
    ).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          spawner.spawn(command.pipe(ChildProcess.setEnv({ PATH: folder }))),
        ),
      ),
    );
  });

it.each(["npm", "curl", "timeout", "flock"])(
  "rejects missing %s before draining and accepts the complete dependency set",
  async (missing) => {
    const folder = mkdtempSync(join(tmpdir(), "usine-upgrade-preflight-"));
    const executable = (name: string, body: string) =>
      writeFileSync(join(folder, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
    try {
      symlinkSync("/bin/bash", join(folder, "bash"));
      executable(
        "systemctl",
        'case "$2" in --property=MainPID) echo 4242;; --property=LoadState) echo loaded;; *) exit 1;; esac',
      );
      for (const command of ["npm", "curl", "timeout", "flock"]) {
        if (command !== missing) executable(command, "exit 0");
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const platform = yield* platformAt(folder);
          assert(Option.isSome(platform));
          const drained = yield* Ref.make(false);
          const upgrades = yield* makeUpgrades({
            running: "1.0.0",
            settings: Effect.succeed({ upgradeChannel: "latest", upgradeMode: "propose" }),
            platform,
            drain: Ref.set(drained, true),
          });
          const error = yield* upgrades
            .request(
              new UpgradeRequest({
                timing: "idle",
                version: Option.some(ReleaseVersion.make("1.1.0")),
              }),
            )
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(UpgradeError);
          expect(error.message).toContain(`Missing required executable: ${missing}`);
          expect(yield* Ref.get(drained)).toBe(false);
          expect((yield* upgrades.status).phase).toBe("idle");
          executable(missing, "exit 0");
          yield* platform.value.preflight;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);

it("waits for a transitive package, deduplicates shared dependencies, and checks again before draining", async () => {
  const folder = mkdtempSync(join(tmpdir(), "usine-upgrade-registry-"));
  const executable = (name: string, body: string) =>
    writeFileSync(join(folder, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  try {
    symlinkSync("/bin/bash", join(folder, "bash"));
    executable(
      "systemctl",
      'case "$2" in --property=MainPID) echo 4242;; --property=LoadState) echo loaded;; *) exit 1;; esac',
    );
    for (const command of ["curl", "timeout", "flock"]) executable(command, "exit 0");
    executable(
      "npm",
      `echo "$2 $3" >> "$PWD/lookups"
case "$2:$3" in
  @usine/server@next:version|@usine/server@1.1.0:version|@usine/engine@^1.1.0:version|@usine/executor@1.1.0:version) echo '"1.1.0"';;
  @usine/server@1.1.0:dependencies) echo '{"@usine/engine":"^1.1.0","@usine/executor":"1.1.0","effect":"4.0.6"}';;
  @usine/engine@1.1.0:dependencies) echo '{}';;
  @usine/executor@1.1.0:dependencies) echo '{"@usine/engine":"^1.1.0","@usine/cloudflare":"1.1.0","@usine/server":"1.1.0"}';;
  @usine/cloudflare@1.1.0:version)
    if [ ! -f "$PWD/ready" ]; then echo 'npm error code ETARGET' >&2; exit 1; fi
    echo '"1.1.0"';;
  @usine/cloudflare@1.1.0:dependencies) echo '{}';;
  *) exit 1;;
esac`,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const platform = yield* platformAt(folder);
        assert(Option.isSome(platform));
        const drained = yield* Ref.make(false);
        const launched = yield* Ref.make(false);
        const upgrades = yield* makeUpgrades({
          running: "1.0.0",
          settings: Effect.succeed({ upgradeChannel: "next", upgradeMode: "propose" }),
          platform: Option.some({
            ...platform.value,
            launch: () => Ref.set(launched, true),
          }),
          drain: Ref.set(drained, true),
        });
        const unavailable = yield* upgrades.check().pipe(Effect.flip);
        expect(unavailable.message).toContain("@usine/cloudflare@1.1.0");
        expect((yield* upgrades.status).available).toBeNull();
        expect(yield* Ref.get(drained)).toBe(false);
        const lookups = readFileSync(join(folder, "lookups"), "utf8");
        expect(lookups.match(/@usine\/engine@\^1\.1\.0 version/gu)).toHaveLength(1);
        expect(lookups).not.toContain("effect@");
        writeFileSync(join(folder, "ready"), "");
        yield* upgrades.check();
        expect((yield* upgrades.status).available).toBe("1.1.0");
        rmSync(join(folder, "ready"));
        const refused = yield* upgrades
          .request(new UpgradeRequest({ timing: "idle", version: Option.none() }))
          .pipe(Effect.flip);
        expect(refused.message).toContain("@usine/cloudflare@1.1.0");
        expect(yield* Ref.get(drained)).toBe(false);
        expect(yield* Ref.get(launched)).toBe(false);
        expect((yield* upgrades.status).phase).toBe("idle");
        writeFileSync(join(folder, "ready"), "");
        yield* upgrades.request(new UpgradeRequest({ timing: "idle", version: Option.none() }));
        yield* Effect.yieldNow;
        expect(yield* Ref.get(drained)).toBe(true);
        expect(yield* Ref.get(launched)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
