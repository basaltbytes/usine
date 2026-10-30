import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DateTime, Effect, FileSystem, Option, Schema } from "effect";
import { UiOrigin } from "@usine/config/factory";
import { DEFAULT_LOG_LEVEL, Port, type UpCommand, UpLogLevel } from "../cli.ts";
import { SystemdUnit } from "./systemd.ts";

/** An operating system process ID. */
export const ProcessId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("ProcessId"));
export type ProcessId = typeof ProcessId.Type;

/** The command that started a `usine up`, which `usine restart` runs again. */
export class InstanceLaunch extends Schema.Class<InstanceLaunch>("@usine/server/InstanceLaunch")({
  /** The Node.js binary, from `process.execPath`. */
  node: Schema.NonEmptyString,
  /** The Node.js options, from `process.execArgv`. */
  nodeOptions: Schema.Array(Schema.String),
  /** The CLI entry point, from `process.argv[1]`. */
  script: Schema.NonEmptyString,
  port: Port,
  /** The origin of `--origin`, which a record omits without one. */
  origin: Schema.OptionFromOptionalKey(UiOrigin).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<UiOrigin>())),
  ),
  /** Decodes as `Info` from a record that a `usine up` without `--log-level` wrote. */
  logLevel: UpLogLevel.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_LOG_LEVEL))),
  allowVolatileInstance: Schema.Boolean,
}) {}

/**
 * Returns how this process was started with the settings of `command`. Dies without
 * `process.argv[1]`, which a CLI always has.
 */
export const currentLaunch = ({ port, origin, logLevel, allowVolatileInstance }: UpCommand) =>
  Schema.decodeUnknownEffect(Schema.NonEmptyString)(process.argv[1]).pipe(
    Effect.map(
      (script) =>
        new InstanceLaunch({
          node: process.execPath,
          nodeOptions: process.execArgv,
          script,
          port,
          origin,
          logLevel,
          allowVolatileInstance,
        }),
    ),
    Effect.orDie,
  );

/**
 * The running `usine up` of an instance folder, as written to `.usine/instance.json`. A newer CLI
 * reads the record that an older engine wrote, so a field added after the first version decodes
 * with a default.
 */
export class InstanceRecord extends Schema.Class<InstanceRecord>("@usine/server/InstanceRecord")({
  pid: ProcessId,
  /** The `@usine/server` version of the process. */
  version: Schema.NonEmptyString,
  startedAt: Schema.DateTimeUtcFromString,
  launch: InstanceLaunch,
  /**
   * The systemd service whose cgroup the process is in, which a record omits outside one. The CLI
   * stops and starts the service with `systemctl` if systemd reports the process as its main one.
   */
  systemdUnit: Schema.OptionFromOptionalKey(SystemdUnit).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<SystemdUnit>())),
  ),
  /** When the process received its first `SIGINT` or `SIGTERM`. */
  stoppingSince: Schema.optionalKey(Schema.DateTimeUtcFromString),
}) {}

/** `.usine/instance.json` exists but doesn't decode as an `InstanceRecord`. */
export class InstanceRecordError extends Schema.TaggedError<InstanceRecordError>(
  "@usine/server/InstanceRecordError",
)("InstanceRecordError", { path: Schema.String, reason: Schema.String }) {}

/** The files that a `usine up` keeps in the instance's `.usine` folder. */
export interface InstanceFiles {
  readonly folder: string;
  readonly lock: string;
  /** The process ID alone, for shell use such as `kill -HUP "$(cat .usine/instance.pid)"`. */
  readonly pid: string;
  readonly record: string;
  /** The output of an instance that `usine up --detach` or `usine restart` started. */
  readonly log: string;
  readonly backups: string;
  /** The instance's ID, which every `usine up` of the folder reuses. */
  readonly id: string;
}

export const instanceFiles = (directory: string): InstanceFiles => {
  const folder = join(directory, ".usine");
  return {
    folder,
    lock: join(folder, "instance.lock"),
    pid: join(folder, "instance.pid"),
    record: join(folder, "instance.json"),
    log: join(folder, "usine.log"),
    backups: join(folder, "backups"),
    id: join(folder, "instance-id"),
  };
};

const encodeRecord = (record: InstanceRecord): string =>
  `${JSON.stringify(Schema.encodeSync(InstanceRecord)(record), null, 2)}\n`;

const RecordFromJson = Schema.fromJsonString(InstanceRecord);

/**
 * Writes the record through a temporary file and a rename, so that readers never see a partial
 * file.
 */
export const writeRecord = Effect.fn("Instance.writeRecord")(function* (
  files: InstanceFiles,
  record: InstanceRecord,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const staging = `${files.record}.${record.pid}`;
  yield* fileSystem.writeFileString(staging, encodeRecord(record), { mode: 0o600 });
  yield* fileSystem.rename(staging, files.record);
});

/** Records `stoppingSince` synchronously, for use in a signal listener. Throws on failure. */
export const markStoppingSync = (files: InstanceFiles, record: InstanceRecord): void => {
  const staging = `${files.record}.${record.pid}`;
  const stopping = new InstanceRecord({
    pid: record.pid,
    version: record.version,
    startedAt: record.startedAt,
    launch: record.launch,
    systemdUnit: record.systemdUnit,
    stoppingSince: DateTime.nowUnsafe(),
  });
  writeFileSync(staging, encodeRecord(stopping), { mode: 0o600 });
  renameSync(staging, files.record);
};

/** Reads `.usine/instance.json`, or returns `None` if it doesn't exist. */
export const readRecord = Effect.fn("Instance.readRecord")(function* (files: InstanceFiles) {
  const fileSystem = yield* FileSystem.FileSystem;
  const failure = (reason: string) => new InstanceRecordError({ path: files.record, reason });
  if (!(yield* fileSystem.exists(files.record).pipe(Effect.mapError((e) => failure(e.message))))) {
    return Option.none<InstanceRecord>();
  }
  const text = yield* fileSystem
    .readFileString(files.record)
    .pipe(Effect.mapError((error) => failure(error.message)));
  return Option.some(
    yield* Schema.decodeUnknownEffect(RecordFromJson)(text).pipe(
      Effect.mapError((error) => failure(error.message)),
    ),
  );
});

const PidFromText = Schema.Trim.pipe(
  Schema.decodeTo(Schema.NumberFromString),
  Schema.decodeTo(ProcessId),
);

/** Reads the process ID in `.usine/instance.pid`, or returns `None` if it's absent or invalid. */
export const readPid = Effect.fn("Instance.readPid")(function* (files: InstanceFiles) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(files.pid).pipe(
    Effect.map(Schema.decodeUnknownOption(PidFromText)),
    Effect.orElseSucceed(() => Option.none<ProcessId>()),
  );
});
