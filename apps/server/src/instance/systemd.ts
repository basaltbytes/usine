import { Effect, FileSystem, Option, Schema } from "effect";
import { runCommand } from "../command.ts";
import type { ProcessId } from "./record.ts";

const SYSTEMCTL_TIMEOUT = "30 seconds";

/** A service of the systemd system manager, such as `usine.service`. */
export const SystemdUnit = Schema.String.check(
  Schema.isPattern(/^[\w:.@\\-]+\.service$/u, { message: "Expected a systemd service name" }),
).pipe(Schema.brand("SystemdUnit"));
export type SystemdUnit = typeof SystemdUnit.Type;

/** Matches the cgroup v2 line of a process in a system service: `0::/system.slice/usine.service`. */
const SYSTEM_SERVICE_CGROUP =
  /^0::\/system\.slice\/(?:[^/\n]+\.slice\/)*([^/\n]+\.service)(?:\/[^\n]*)?$/mu;

/**
 * Returns the system service in the contents of `/proc/<pid>/cgroup`, or `None` for a process
 * outside one, such as in a login session or under a user's service manager.
 */
export const systemServiceOf = (cgroup: string): Option.Option<SystemdUnit> =>
  Option.flatMap(
    Option.fromNullishOr(SYSTEM_SERVICE_CGROUP.exec(cgroup)?.[1]),
    Schema.decodeUnknownOption(SystemdUnit),
  );

/**
 * Returns the system service whose cgroup this process is in, or `None` outside one and on systems
 * without `/proc`.
 */
export const currentSystemService = Effect.fn("Instance.currentSystemService")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cgroup = yield* fileSystem.readFileString("/proc/self/cgroup").pipe(
    Effect.tapError((error) =>
      Effect.logDebug("Could not read this process's cgroup; no systemd service runs it", {
        reason: error.message,
      }),
    ),
    Effect.option,
  );
  const unit = Option.flatMap(cgroup, systemServiceOf);
  if (Option.isSome(unit)) {
    yield* Effect.logInfo("usine up runs in a systemd service", { unit: unit.value });
  }
  return unit;
});

/** `systemctl` couldn't run, or exited with a non-zero status. */
export class SystemctlError extends Schema.TaggedError<SystemctlError>(
  "@usine/server/SystemctlError",
)("SystemctlError", { command: Schema.String, unit: SystemdUnit, reason: Schema.String }) {}

/** Runs `systemctl <args> <unit>` and returns its standard output. */
export const systemctl = (unit: SystemdUnit, args: ReadonlyArray<string>) =>
  runCommand("systemctl", [...args, unit], "/", SYSTEMCTL_TIMEOUT).pipe(
    Effect.map(({ stdout }) => stdout),
    Effect.mapError(({ command, reason }) => new SystemctlError({ command, unit, reason })),
  );

const MainPid = Schema.Trim.pipe(
  Schema.decodeTo(Schema.NumberFromString),
  Schema.decodeTo(Schema.Int),
);

/**
 * Returns `unit` if systemd reports `pid` as its main process, or `None` without a unit or if
 * the unit's main process is another one, as for a `usine up` that a service's script started.
 */
export const supervisingUnit = Effect.fn("Instance.supervisingUnit")(function* (
  pid: ProcessId,
  unit: Option.Option<SystemdUnit>,
) {
  if (Option.isNone(unit)) return Option.none<SystemdUnit>();
  yield* Effect.annotateCurrentSpan({ pid, unit: unit.value });
  const mainPid = Schema.decodeUnknownOption(MainPid)(
    yield* systemctl(unit.value, ["show", "--property=MainPID", "--value"]),
  );
  if (Option.contains(mainPid, pid)) return unit;
  yield* Effect.logInfo(
    "The instance process isn't the main process of its systemd service; usine signals it directly",
    { pid, unit: unit.value, mainPid: Option.getOrUndefined(mainPid) },
  );
  return Option.none<SystemdUnit>();
});

/** The `ActiveState` and `SubState` of a unit, such as `active` and `running`. */
interface UnitState {
  readonly active: string;
  readonly sub: string;
}

/** Returns the state of `unit` from `systemctl show`. */
export const unitState = Effect.fn("Instance.unitState")(function* (unit: SystemdUnit) {
  const properties = new Map(
    (yield* systemctl(unit, ["show", "--property=ActiveState", "--property=SubState"]))
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
      }),
  );
  return {
    active: properties.get("ActiveState") ?? "unknown",
    sub: properties.get("SubState") ?? "unknown",
  } satisfies UnitState;
});
