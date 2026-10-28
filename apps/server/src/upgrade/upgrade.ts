import { requestSystemUpgrade } from "./client.ts";
import { join, sep } from "node:path";
import type { InstanceDirectory } from "@usine/core/instance";
import { Console, DateTime, Duration, Effect, FileSystem, Option, Schema } from "effect";
import { backup } from "../backup.ts";
import type { UpgradeCommand } from "../cli.ts";
import { runCommand, runInTerminal } from "../command.ts";
import { startAgain, startedMessage } from "../detach.ts";
import {
  type InstanceManifest,
  PackageManager,
  SERVER_PACKAGE,
  bumpPins,
  compareVersions,
  installedInInstance,
  parseManifest,
  readManifest,
  realPathOrSelf,
  serverPin,
} from "../instance/manifest.ts";
import { type InstanceRecord, instanceFiles } from "../instance/record.ts";
import { probeInstance } from "../instance/state.ts";
import { SystemdUnit, supervisingUnit } from "../instance/systemd.ts";
import { dependenciesOf, resolveVersion } from "../registry.ts";
import {
  UnrecordedInstanceError,
  refuseLiveAttempts,
  refuseMissingEnvironment,
  stopProcess,
} from "../stop.ts";

const GIT_TIMEOUT = "30 seconds";

/** The running engine isn't installed in the instance's `node_modules`, so no pin selects it. */
export class EngineOutsideInstanceError extends Schema.TaggedError<EngineOutsideInstanceError>(
  "@usine/server/EngineOutsideInstanceError",
)("EngineOutsideInstanceError", {
  script: Schema.String,
  version: Schema.String,
  /** Whether the entry point is in a `node_modules` folder, as with a global install. */
  packaged: Schema.Boolean,
}) {}

/** The instance's `package.json` is absent or doesn't pin `@usine/server` to a registry version. */
export class EnginePinError extends Schema.TaggedError<EnginePinError>(
  "@usine/server/EnginePinError",
)("EnginePinError", {
  path: Schema.String,
  missing: Schema.Boolean,
  /** The local spec, such as `link:../usine/apps/server`, if `@usine/server` has one. */
  linked: Schema.Option(Schema.String),
}) {}

/** A file that `usine upgrade` reads or writes couldn't be accessed. */
export class UpgradeFileError extends Schema.TaggedError<UpgradeFileError>(
  "@usine/server/UpgradeFileError",
)("UpgradeFileError", { path: Schema.String, reason: Schema.String }) {}

/**
 * `usine upgrade` failed after it changed the pin. `install` restored the pin, `start` left the
 * instance stopped, and `listen` left a new process that doesn't answer.
 */
export class UpgradeFailedError extends Schema.TaggedError<UpgradeFailedError>(
  "@usine/server/UpgradeFailedError",
)("UpgradeFailedError", {
  stage: Schema.Literals(["install", "start", "listen"]),
  reason: Schema.String,
  previous: Schema.String,
  target: Schema.String,
  packageManager: PackageManager,
  /** The runtime store copy, if the instance had a runtime store. The durable copy is next to it. */
  backup: Schema.Option(Schema.String),
  /** The commit of the pin change, if `usine upgrade` made one. */
  commit: Schema.Option(Schema.String),
  /** The last lines of `.usine/usine.log`, for a failed start. */
  tail: Schema.String,
  /** The systemd service that runs the instance, whose journal has its output. */
  unit: Schema.Option(SystemdUnit),
}) {}

const backupStamp = (now: DateTime.Utc): string =>
  DateTime.formatIso(now)
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "Z");

/** Returns the versions for the pins: the server's dependency spec for each, or else `latest`. */
const targetVersions = Effect.fn("Cli.upgradeTargets")(function* (
  directory: InstanceDirectory,
  manifest: InstanceManifest,
  target: string,
) {
  const serverDependencies = yield* dependenciesOf(directory, SERVER_PACKAGE, target);
  const versions = new Map<string, string>([[SERVER_PACKAGE, target]]);
  for (const { name } of manifest.pins) {
    if (name === SERVER_PACKAGE) continue;
    const spec = Option.getOrElse(Option.fromUndefinedOr(serverDependencies[name]), () => "latest");
    versions.set(name, yield* resolveVersion(directory, name, spec));
  }
  return versions;
});

/** Commits `paths` alone and returns the short commit hash. */
const commitPin = Effect.fn("Cli.commitPin")(function* (
  directory: InstanceDirectory,
  paths: ReadonlyArray<string>,
  message: string,
) {
  yield* runCommand("git", ["add", "--", ...paths], directory, GIT_TIMEOUT);
  yield* runCommand(
    "git",
    ["commit", "--quiet", "-m", message, "--", ...paths],
    directory,
    GIT_TIMEOUT,
  );
  const { stdout } = yield* runCommand(
    "git",
    ["rev-parse", "--short", "HEAD"],
    directory,
    GIT_TIMEOUT,
  );
  return stdout.trim();
});

/** Prints the lines of `--check`. */
const printLines = (lines: ReadonlyArray<string>) =>
  Effect.forEach(lines, (line) => Console.log(line), { discard: true });

const targetLabel = (command: UpgradeCommand) =>
  Option.isSome(command.version) ? "requested " : "latest    ";

const runningLine = (record: InstanceRecord, from: string) =>
  `running   ${SERVER_PACKAGE} ${record.version}${from}`;

/**
 * Moves the instance's `@usine/*` pins to `command.version`, or to `latest`. Refuses while
 * Attempts are live, unless `--force`. Backs up the stores to `.usine/backups/`, stops the
 * instance, installs with the instance's package manager, commits the pin change, and starts the
 * instance again if it was running.
 */
export const upgrade = Effect.fn("Cli.upgrade")(function* (
  directory: InstanceDirectory,
  command: UpgradeCommand,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const files = instanceFiles(directory);
  const fileError = (path: string) => (error: { readonly message: string }) =>
    new UpgradeFileError({ path, reason: error.message });
  const state = yield* probeInstance(directory);
  if (state._tag === "Unrecorded") {
    return yield* new UnrecordedInstanceError({ command: "upgrade", directory, pid: state.pid });
  }
  const running: Option.Option<InstanceRecord> =
    state._tag === "Running" ? Option.some(state.record) : Option.none();
  const spec = Option.getOrElse(command.version, () => "latest");
  yield* Effect.annotateCurrentSpan({ instanceDirectory: directory, spec });

  // Only a running engine shows where it runs from. A stopped one is whatever the pin installs.
  if (Option.isSome(running)) {
    const script = running.value.launch.script;
    if (!installedInInstance(yield* realPathOrSelf(directory), yield* realPathOrSelf(script))) {
      const unit = yield* supervisingUnit(running.value.pid, running.value.systemdUnit);
      if (
        Option.isSome(unit) &&
        (yield* realPathOrSelf(script)).endsWith("/lib/node_modules/@usine/server/dist/main.js")
      ) {
        return yield* requestSystemUpgrade(directory, running.value, command);
      }
      if (!command.check) {
        return yield* new EngineOutsideInstanceError({
          script,
          version: running.value.version,
          packaged: script.includes(`${sep}node_modules${sep}`),
        });
      }
      return yield* printLines([
        runningLine(running.value, ` from ${script}`),
        `${targetLabel(command)}${yield* resolveVersion(directory, SERVER_PACKAGE, spec)}`,
        "The engine runs from outside the instance's node_modules, so usine upgrade doesn't change it.",
      ]);
    }
  }

  const manifestPath = join(directory, "package.json");
  const manifest = yield* readManifest(directory);
  if (Option.isNone(manifest)) {
    return yield* new EnginePinError({ path: manifestPath, missing: true, linked: Option.none() });
  }
  const pin = serverPin(manifest.value);
  if (Option.isNone(pin)) {
    return yield* new EnginePinError({
      path: manifestPath,
      missing: false,
      linked: manifest.value.linkedServer,
    });
  }
  const previous = pin.value.spec;
  const target = yield* resolveVersion(directory, SERVER_PACKAGE, spec);
  if (command.check) {
    return yield* printLines([
      ...Option.toArray(Option.map(running, (record) => runningLine(record, ""))),
      `pinned    ${previous} in package.json`,
      `${targetLabel(command)}${target}`,
      previous === target
        ? "The pin is up to date."
        : `Run usine upgrade${Option.isSome(command.version) ? ` ${spec}` : ""} to move the pin to ${target}.`,
    ]);
  }
  if (previous === target) {
    yield* Console.log(`${SERVER_PACKAGE} is already pinned to ${target}.`);
    if (Option.isSome(running) && running.value.version !== target) {
      yield* Console.log(
        `The running engine is ${running.value.version}. Run usine restart to start ${target}.`,
      );
    }
    return;
  }
  if (Option.isNone(command.version) && compareVersions(target, previous) < 0) {
    yield* Console.log(
      `The latest release, ${target}, is older than the pinned ${previous}. To change the pin, run usine upgrade <version>.`,
    );
    return;
  }

  const versions = yield* targetVersions(directory, manifest.value, target);
  const lockfiles = yield* Effect.forEach(manifest.value.lockfiles, (file) => {
    const path = join(directory, file);
    return fileSystem.readFileString(path).pipe(
      Effect.map((text) => [path, text] as const),
      Effect.mapError(fileError(path)),
    );
  });
  const restore = Effect.forEach(
    [[manifest.value.path, manifest.value.text] as const, ...lockfiles],
    ([path, text]) =>
      fileSystem.writeFileString(path, text).pipe(
        Effect.tapError((error) =>
          Effect.logError("Could not restore a file after a failed install", {
            path,
            message: error.message,
          }),
        ),
        Effect.ignore,
      ),
    { discard: true },
  );
  const bumped = bumpPins(manifest.value.text, manifest.value.pins, versions);
  const rewritten = yield* parseManifest(manifest.value.path, bumped, manifest.value.lockfiles);
  if (!Option.exists(serverPin(rewritten), ({ spec: pinned }) => pinned === target)) {
    return yield* Effect.die(new Error(`Could not rewrite the ${SERVER_PACKAGE} pin`));
  }
  if (Option.isSome(running)) {
    yield* refuseMissingEnvironment("upgrade", running.value.launch.port);
    yield* refuseLiveAttempts("upgrade", running.value.launch.port, command.options.force);
  }
  const unit = Option.isSome(running)
    ? yield* supervisingUnit(running.value.pid, running.value.systemdUnit)
    : Option.none<SystemdUnit>();
  yield* Effect.logInfo("Upgrading the engine pin of the instance", {
    from: previous,
    to: target,
    packageManager: manifest.value.packageManager,
  });
  yield* Console.log(`Upgrading ${SERVER_PACKAGE} from ${previous} to ${target}.`);

  const runtimeStore = join(files.folder, "runtime.sqlite");
  const hasStore = yield* fileSystem
    .exists(runtimeStore)
    .pipe(Effect.mapError(fileError(runtimeStore)));
  // Named after the engine that wrote the store, which its migrations match.
  const writer = Option.match(running, {
    onNone: () => previous,
    onSome: ({ version }) => version,
  });
  const backupPath = hasStore
    ? Option.some(
        join(files.backups, `runtime-${backupStamp(yield* DateTime.now)}-${writer}.sqlite`),
      )
    : Option.none<string>();
  if (Option.isSome(backupPath)) {
    yield* fileSystem
      .makeDirectory(files.backups, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(fileError(files.backups)));
    yield* backup(directory, backupPath.value);
  } else {
    yield* Console.log("No runtime store to back up: .usine/runtime.sqlite does not exist.");
  }

  if (Option.isSome(running)) {
    yield* stopProcess("upgrade", running.value.pid, running, unit, command.options);
  }

  const failure = (
    stage: UpgradeFailedError["stage"],
    reason: string,
    commit: Option.Option<string>,
    tail: string,
  ) =>
    new UpgradeFailedError({
      stage,
      reason,
      previous,
      target,
      packageManager: manifest.value.packageManager,
      backup: backupPath,
      commit,
      tail,
      unit,
    });
  yield* fileSystem
    .writeFileString(manifest.value.path, bumped)
    .pipe(Effect.mapError(fileError(manifest.value.path)));
  yield* runInTerminal(manifest.value.packageManager, ["install"], directory).pipe(
    Effect.catchTag("CommandError", (error) =>
      restore.pipe(
        Effect.andThen(
          Effect.fail(failure("install", `${error.command} ${error.reason}`, Option.none(), "")),
        ),
      ),
    ),
  );

  const installed = yield* readManifest(directory);
  const paths = [
    "package.json",
    ...Option.match(installed, { onNone: () => [], onSome: ({ lockfiles: present }) => present }),
  ];
  const commit = yield* commitPin(directory, paths, `Pin ${SERVER_PACKAGE} to ${target}`).pipe(
    Effect.map(Option.some),
    Effect.catchTag("CommandError", (error) =>
      Console.log(
        `Could not commit the pin change (${error.command} ${error.reason}). Commit ${paths.join(", ")} yourself.`,
      ).pipe(Effect.as(Option.none<string>())),
    ),
  );
  if (Option.isSome(commit)) yield* Console.log(`Committed the pin change as ${commit.value}.`);

  if (Option.isNone(running)) {
    yield* Console.log(
      `${SERVER_PACKAGE} is now ${target}. usine wasn't running, so start it with usine up --detach.`,
    );
    return;
  }
  const started = yield* startAgain(
    directory,
    running.value.launch,
    unit,
    running.value.pid,
    command.options.timeout,
  ).pipe(
    Effect.catchTags({
      DetachedStartError: (error) =>
        Effect.fail(
          error.outcome === "exited"
            ? failure(
                "start",
                `it exited (${Option.getOrElse(error.exit, () => "unknown")}) before it listened`,
                commit,
                error.tail,
              )
            : failure(
                "listen",
                `it didn't answer on port ${error.port}, and wrote nothing to its log for ${Duration.format(error.timeout)}`,
                commit,
                error.tail,
              ),
        ),
      SystemdStartError: (error) =>
        Effect.fail(
          error.outcome === "failed"
            ? failure("start", `${error.unit} was ${error.state} before it listened`, commit, "")
            : failure(
                "listen",
                `it didn't answer within ${Duration.format(error.timeout)}`,
                commit,
                "",
              ),
        ),
    }),
  );
  yield* Console.log(startedMessage(started));
});
