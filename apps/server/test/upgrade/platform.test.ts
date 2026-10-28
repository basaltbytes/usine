import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const platform = yield* systemUpgradePlatform(
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
