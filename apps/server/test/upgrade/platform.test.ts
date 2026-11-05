// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { ReleaseVersion } from "@usine/core/upgrade";
import { UpgradeRequest } from "@usine/orchestrator/operator/http";
import { DateTime, Effect, Option, Ref } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { assert, expect, it } from "@effect/vitest";
import { Port } from "../../src/cli.ts";
import { InstanceLaunch, InstanceRecord, ProcessId } from "../../src/instance/record.ts";
import { LaunchdService } from "../../src/instance/launchd.ts";
import { SystemdUnit } from "../../src/instance/systemd.ts";
import { makeUpgrades, UpgradeError } from "../../src/upgrade/control.ts";
import { systemUpgradePlatform } from "../../src/upgrade/platform.ts";

const platformAt = (folder: string, manager: "systemd" | "launchd" = "systemd") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* systemUpgradePlatform(
      InstanceDirectory.make(folder),
      InstanceRecord.make({
        pid: ProcessId.make(4242),
        version: "1.0.0",
        startedAt: DateTime.nowUnsafe(),
        systemdUnit:
          manager === "systemd" ? Option.some(SystemdUnit.make("usine.service")) : Option.none(),
        launchdService:
          manager === "launchd"
            ? Option.some(LaunchdService.make("gui/501/dev.usine"))
            : Option.none(),
        launch: InstanceLaunch.make({
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

const commands = ["node", "npm", "curl", "timeout", "flock", "stat", "df", "find", "sort"];

it.live.each(commands)(
  "rejects missing %s before draining and accepts the complete dependency set",
  (missing) =>
    Effect.gen(function* () {
      const folder = mkdtempSync(join(tmpdir(), "usine-upgrade-preflight-"));
      const executable = (name: string, body: string) =>
        writeFileSync(join(folder, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
      try {
        symlinkSync("/bin/bash", join(folder, "bash"));
        executable(
          "systemctl",
          'case "$2" in --property=MainPID) echo 4242;; --property=LoadState) echo loaded;; *) exit 1;; esac',
        );
        for (const command of commands) {
          if (command !== missing) executable(command, "exit 0");
        }
        yield* Effect.gen(function* () {
          const platform = yield* platformAt(folder);
          assert(Option.isSome(platform));
          const drained = yield* Ref.make(false);
          const upgrades = yield* makeUpgrades({
            running: "1.0.0",
            settings: Effect.succeed({ upgradeChannel: "latest", upgradeMode: "propose" }),
            platform,
            drain: () => Ref.set(drained, true),
            resume: Effect.void,
          });
          const error = yield* upgrades
            .request(
              UpgradeRequest.make({
                timing: "idle",
                version: Option.some(ReleaseVersion.make("1.1.0")),
              }),
            )
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(UpgradeError);
          expect(error.message).toContain(`Missing required executable: ${missing}`);
          const drainedState = yield* Ref.get(drained);
          expect(drainedState).toBe(false);
          expect((yield* upgrades.status).phase).toBe("idle");
          executable(missing, "exit 0");
          yield* platform.value.preflight;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }),
);

it.live(
  "waits for a transitive package, deduplicates shared dependencies, and checks again before draining",
  () =>
    Effect.gen(function* () {
      const folder = mkdtempSync(join(tmpdir(), "usine-upgrade-registry-"));
      const executable = (name: string, body: string) =>
        writeFileSync(join(folder, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
      try {
        symlinkSync("/bin/bash", join(folder, "bash"));
        executable(
          "systemctl",
          'case "$2" in --property=MainPID) echo 4242;; --property=LoadState) echo loaded;; *) exit 1;; esac',
        );
        for (const command of commands.filter((name) => name !== "npm"))
          executable(command, "exit 0");
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
        yield* Effect.gen(function* () {
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
            drain: () => Ref.set(drained, true),
            resume: Effect.void,
          });
          const unavailable = yield* upgrades.check().pipe(Effect.flip);
          expect(unavailable.message).toContain("@usine/cloudflare@1.1.0");
          expect((yield* upgrades.status).available).toBeNull();
          const drainedState = yield* Ref.get(drained);
          expect(drainedState).toBe(false);
          const lookups = readFileSync(join(folder, "lookups"), "utf8");
          expect(lookups.match(/@usine\/engine@\^1\.1\.0 version/gu)).toHaveLength(1);
          expect(lookups).not.toContain("effect@");
          writeFileSync(join(folder, "ready"), "");
          yield* upgrades.check();
          expect((yield* upgrades.status).available).toBe("1.1.0");
          rmSync(join(folder, "ready"));
          const refused = yield* upgrades
            .request(UpgradeRequest.make({ timing: "idle", version: Option.none() }))
            .pipe(Effect.flip);
          expect(refused.message).toContain("@usine/cloudflare@1.1.0");
          const currentDrainedState = yield* Ref.get(drained);
          expect(currentDrainedState).toBe(false);
          const launchedState = yield* Ref.get(launched);
          expect(launchedState).toBe(false);
          expect((yield* upgrades.status).phase).toBe("idle");
          writeFileSync(join(folder, "ready"), "");
          yield* upgrades.request(UpgradeRequest.make({ timing: "idle", version: Option.none() }));
          yield* Effect.yieldNow;
          const nextDrainedState = yield* Ref.get(drained);
          expect(nextDrainedState).toBe(true);
          const currentLaunchedState = yield* Ref.get(launched);
          expect(currentLaunchedState).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    }),
);

it.live("preflights and launches an independent launchd helper, and detects a stopped helper", () =>
  Effect.gen(function* () {
    const folder = mkdtempSync(join(tmpdir(), "usine-launchd-upgrade-"));
    const executable = (name: string, body: string) =>
      writeFileSync(join(folder, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
    try {
      symlinkSync("/bin/bash", join(folder, "bash"));
      for (const command of commands) executable(command, "exit 0");
      executable(
        "launchctl",
        `case "$1" in
  print)
    if [ "$2" = gui/501/dev.usine ]; then printf 'state = running\\npid = 4242\\n';
    else echo 'state = not running'; fi;;
  kickstart) echo "$2" > '${folder}/started';;
  *) exit 1;;
esac`,
      );
      yield* Effect.gen(function* () {
        const platform = yield* platformAt(folder, "launchd");
        assert(Option.isSome(platform));
        executable("stat", "exit 1");
        const dependencies = yield* platform.value.preflight.pipe(Effect.flip);
        expect(dependencies.message).toContain("GNU coreutils and findutils");
        executable("stat", "exit 0");
        yield* platform.value.preflight;
        yield* platform.value.launch(ReleaseVersion.make("1.1.0"));
        expect(readFileSync(join(folder, "started"), "utf8").trim()).toBe(
          "gui/501/dev.usine-upgrade",
        );
        const helper = readFileSync(join(folder, ".usine/upgrade/run.sh"), "utf8");
        expect(helper).toContain("service_manager='launchd'");
        expect(helper).toContain("launchctl bootout");
        expect(helper).toContain("@usine/server@$version");
        const outcome = yield* platform.value.outcome;
        assert(Option.isSome(outcome));
        expect(outcome.value.status).toBe("failed");
        executable("launchctl", 'echo "Operation not permitted" >&2; exit 1');
        const error = yield* platform.value.preflight.pipe(Effect.flip);
        expect(error.message).toContain("Operation not permitted");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }),
);
