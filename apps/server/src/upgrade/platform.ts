import { ChildProcessSpawner } from "effect/process";
import type { InstanceDirectory } from "@usine/core/instance";
import { ReleaseVersion, UpgradeRecord } from "@usine/core/upgrade";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { runCommand } from "../command.ts";
import { realPathOrSelf, SERVER_PACKAGE } from "../instance/manifest.ts";
import type { InstanceRecord } from "../instance/record.ts";
import { SystemdUnit, supervisingUnit, systemctl, unitState } from "../instance/systemd.ts";
import { dependenciesOf, resolveVersion } from "../registry.ts";
import { UpgradeError, type UpgradePlatform } from "./control.ts";

const failure = (error: { readonly message: string }) =>
  UpgradeError.make({ message: error.message });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const systemUpgradePlatform = Effect.fn("Server.systemUpgradePlatform")(function* (
  directory: InstanceDirectory,
  record: InstanceRecord,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
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
  const previous = yield* Schema.decodeEffect(ReleaseVersion)(record.version).pipe(
    Effect.mapError(failure),
  );
  const fs = yield* FileSystem.FileSystem;
  const folder = path.join(directory, ".usine", "upgrade");
  const resultPath = path.join(folder, "result.json");
  const checkDependencies = Effect.fn("Server.checkUpgradeDependencies")(
    function* (target: ReleaseVersion) {
      yield* Effect.annotateCurrentSpan({ previous, target });
      const pending: Array<readonly [string, string]> = [[SERVER_PACKAGE, target]];
      const checked = new Set<string>();
      for (const [name, spec] of pending) {
        const key = `${name}@${spec}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const version = yield* resolveVersion(directory, name, spec);
        const dependencies = yield* dependenciesOf(directory, name, version);
        pending.push(
          ...Object.entries(dependencies).filter(([name]) => name.startsWith("@usine/")),
        );
      }
      yield* Effect.logInfo("Server upgrade dependencies are available", {
        previous,
        target,
        packages: checked.size,
      });
    },
    Effect.catchTag("PackageLookupError", (error) =>
      Effect.logInfo("Server upgrade waits for registry packages", {
        package: error.packageName,
        spec: error.spec,
        reason: error.reason,
      }).pipe(
        Effect.andThen(
          UpgradeError.make({
            message: `Waiting for ${error.packageName}@${error.spec} on the registry: ${error.reason}`,
          }),
        ),
      ),
    ),
  );
  const readOutcome = Effect.gen(function* () {
    if (!(yield* fs.exists(resultPath))) return Option.none<UpgradeRecord>();
    const contents = yield* fs.readFileString(resultPath);
    const upgradeRecord = yield* Schema.decodeEffect(Schema.fromJsonString(UpgradeRecord))(
      contents,
      { onExcessProperty: "error" },
    );
    return Option.some(upgradeRecord);
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
  const preflight = Effect.fn("Server.upgradePreflight")(function* () {
    yield* Effect.annotateCurrentSpan({ previous, unit: service, helperUnit, prefix });
    const loaded = yield* systemctl(helperUnit, ["show", "--property=LoadState", "--value"]).pipe(
      Effect.mapError(failure),
    );
    if (loaded.trim() !== "loaded") {
      return yield* UpgradeError.make({
        message: `Install ${helperUnit} and its polkit rule before upgrading. See the server setup guide.`,
      });
    }
    yield* runCommand(
      "bash",
      [
        "-c",
        'for executable in npm curl timeout flock; do command -v "$executable" >/dev/null || { printf "Missing required executable: %s\\n" "$executable" >&2; exit 1; }; done',
      ],
      directory,
      "10 seconds",
    ).pipe(Effect.mapError(({ reason }) => UpgradeError.make({ message: reason })));
  });
  const launch = Effect.fn("Server.launchUpgradeHelper")(function* (target: ReleaseVersion) {
    yield* Effect.annotateCurrentSpan({ previous, target, unit: service, prefix });
    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
    const helperPath = yield* path.fromFileUrl(new URL("./helper.sh", import.meta.url));
    const helper = yield* fs.readFileString(helperPath);
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
    yield* fs.writeFileString(path.join(folder, "run.sh"), `${variables}\n${helper}`, {
      mode: 0o700,
    });
    const serializedRecord = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      UpgradeRecord.make({ previous, target, status: "installing" }),
    ).pipe(Effect.orDie);
    yield* fs.writeFileString(resultPath, serializedRecord, { mode: 0o600 });
    yield* systemctl(helperUnit, ["start", "--no-block"]);
    yield* Effect.logInfo("Started the independent upgrade helper", {
      previous,
      target,
      unit: helperUnit,
      prefix,
    });
  }, Effect.mapError(failure));
  return Option.some({
    checkDependencies: (target) =>
      checkDependencies(target).pipe(Effect.annotateLogs({ previous, target }), provideSpawner),
    preflight: preflight().pipe(provideSpawner),
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
