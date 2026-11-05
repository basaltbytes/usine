import { Effect, Option, Schema } from "effect";
import type { InstanceRecord } from "./record.ts";
import {
  LaunchdService,
  type LaunchctlError,
  launchctl,
  launchdState,
  startLaunchdService,
  supervisingLaunchdService,
} from "./launchd.ts";
import {
  type SystemctlError,
  SystemdUnit,
  supervisingUnit,
  systemctl,
  unitState,
} from "./systemd.ts";

export type ServiceError = LaunchctlError | SystemctlError;

export const ServiceUnit = Schema.Union([SystemdUnit, LaunchdService]);
export type ServiceUnit = typeof ServiceUnit.Type;

export const supervisingService = Effect.fn("Instance.supervisingService")(function* (
  record: InstanceRecord,
) {
  yield* Effect.annotateCurrentSpan({ pid: record.pid });
  const unit: Option.Option<ServiceUnit> = Option.isSome(record.launchdService)
    ? yield* supervisingLaunchdService(record.pid, record.launchdService)
    : yield* supervisingUnit(record.pid, record.systemdUnit);
  return unit;
});

export const startService = Effect.fn("Instance.startService")(function* (unit: ServiceUnit) {
  yield* Effect.annotateCurrentSpan({ unit });
  if (Schema.is(LaunchdService)(unit)) yield* startLaunchdService(unit);
  else yield* systemctl(unit, ["start"]);
});

export const stopService = Effect.fn("Instance.stopService")(function* (unit: ServiceUnit) {
  yield* Effect.annotateCurrentSpan({ unit });
  if (Schema.is(LaunchdService)(unit)) yield* launchctl(unit, ["bootout", unit]);
  else yield* systemctl(unit, ["stop", "--no-block"]);
});

export const serviceState = Effect.fn("Instance.serviceState")(function* (unit: ServiceUnit) {
  yield* Effect.annotateCurrentSpan({ unit });
  return yield* Schema.is(LaunchdService)(unit)
    ? launchdState(unit).pipe(
        Effect.map(
          Option.match({
            onNone: () => ({ active: "inactive", sub: "unloaded" }),
            onSome: ({ pid, state }) => ({
              active: Option.isSome(pid)
                ? "active"
                : state === "waiting" || state === "not running"
                  ? "inactive"
                  : "activating",
              sub: state,
            }),
          }),
        ),
      )
    : unitState(unit);
});

export const serviceOutput = (unit: ServiceUnit): string =>
  Schema.is(LaunchdService)(unit) ? ".usine/usine.log" : `journalctl -u ${unit}`;

export const serviceStartCommand = (unit: ServiceUnit): string =>
  Schema.is(LaunchdService)(unit) ? "usine up --detach" : `systemctl start ${unit}`;

export const serviceStopCommand = (unit: ServiceUnit): string =>
  Schema.is(LaunchdService)(unit) ? `launchctl bootout ${unit}` : `systemctl stop ${unit}`;
