import { ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstanceDirectory } from "@usine/core/instance";
import { ReleaseVersion, UpgradeRecord } from "@usine/core/upgrade";
import { Effect, FileSystem, Option, Schema } from "effect";
import { runCommand } from "../command.ts";
import { realPathOrSelf, SERVER_PACKAGE } from "../instance/manifest.ts";
import type { InstanceRecord } from "../instance/record.ts";
import { SystemdUnit, supervisingUnit, systemctl, unitState } from "../instance/systemd.ts";
import { resolveVersion } from "../registry.ts";
import { UpgradeError, type UpgradePlatform } from "./control.ts";

const failure = (error: { readonly message: string }) =>
  new UpgradeError({ message: error.message });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const systemUpgradePlatform = Effect.fn("Server.systemUpgradePlatform")(function* (
  directory: InstanceDirectory,
  record: InstanceRecord,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const provideSpawner = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner);
  const unit = yield* supervisingUnit(record.pid, record.systemdUnit).pipe(
    Effect.mapError(failure),
  );
  const script = yield* realPathOrSelf(record.launch.script);
  const suffix = "/lib/node_modules/@usine/server/dist/main.js";
  if (Option.isNone(unit) || !script.endsWith(suffix)) return Option.none<UpgradePlatform>();
  const prefix = script.slice(0, -suffix.length);
  const service = unit.value;
  const helperUnit = SystemdUnit.make(`${service.slice(0, -".service".length)}-upgrade.service`);
  const previous = yield* Schema.decodeUnknownEffect(ReleaseVersion)(record.version).pipe(
    Effect.mapError(failure),
  );
  const fs = yield* FileSystem.FileSystem;
  const folder = join(directory, ".usine", "upgrade");
  const resultPath = join(folder, "result.json");
  const readOutcome = Effect.gen(function* () {
    if (!(yield* fs.exists(resultPath))) return Option.none<UpgradeRecord>();
    return Option.some(
      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(UpgradeRecord))(
        yield* fs.readFileString(resultPath),
        { onExcessProperty: "error" },
      ),
    );
  }).pipe(Effect.mapError(failure));
  const outcome = Effect.gen(function* () {
    const result = yield* readOutcome;
    if (Option.isSome(result) && result.value.status === "installing") {
      const state = yield* unitState(helperUnit).pipe(Effect.mapError(failure));
      if (state.active !== "active" && state.active !== "activating") {
        return Option.some(
          UpgradeRecord.make({
            ...result.value,
            status: "failed",
            reason:
              "The upgrade helper stopped before recording an outcome. Check its service journal.",
          }),
        );
      }
    }
    return result;
  });
  const preflight = Effect.gen(function* () {
    const loaded = yield* systemctl(helperUnit, ["show", "--property=LoadState", "--value"]).pipe(
      Effect.mapError(failure),
    );
    if (loaded.trim() !== "loaded") {
      return yield* new UpgradeError({
        message: `Install ${helperUnit} and its polkit rule before upgrading. See the server setup guide.`,
      });
    }
    yield* runCommand(
      "bash",
      ["-c", "command -v npm curl timeout flock >/dev/null"],
      directory,
      "10 seconds",
    ).pipe(Effect.mapError(failure));
  });
  const launch = Effect.fn("Server.launchUpgradeHelper")(function* (target: ReleaseVersion) {
    yield* Effect.annotateCurrentSpan({ previous, target, unit: service, prefix });
    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
    const helper = yield* fs.readFileString(fileURLToPath(new URL("./helper.sh", import.meta.url)));
    const variables = Object.entries({
      folder,
      previous,
      target,
      prefix,
      unit: service,
      port: String(record.launch.port),
    })
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join("\n");
    yield* fs.writeFileString(join(folder, "run.sh"), `${variables}\n${helper}`, { mode: 0o700 });
    yield* fs.writeFileString(
      resultPath,
      JSON.stringify(UpgradeRecord.make({ previous, target, status: "installing" })),
      { mode: 0o600 },
    );
    yield* systemctl(helperUnit, ["start", "--no-block"]);
    yield* Effect.logInfo("Started the independent upgrade helper", {
      previous,
      target,
      unit: helperUnit,
      prefix,
    });
  }, Effect.mapError(failure));
  return Option.some({
    preflight: preflight.pipe(provideSpawner),
    outcome: outcome.pipe(provideSpawner),
    launch: (target) => launch(target).pipe(provideSpawner),
    lookup: (channel) =>
      resolveVersion(directory, SERVER_PACKAGE, channel).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ReleaseVersion)),
        Effect.mapError(failure),
        provideSpawner,
      ),
  } satisfies UpgradePlatform);
});
