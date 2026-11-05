import { type Brand, Config, Effect, Option, Path, Schema } from "effect";
import { runCommand } from "../command.ts";
import type { ProcessId } from "./record.ts";

/** A per-user launchd service target, such as `gui/501/dev.usine`. */
export const LaunchdService = Schema.String.check(
  Schema.isPattern(/^gui\/[0-9]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/u),
).pipe(Schema.brand("LaunchdService"));
export type LaunchdService = typeof LaunchdService.Type;

export class LaunchctlError extends Schema.TaggedError<
  LaunchctlError,
  Brand.Brand<"@usine/server/instance/launchd/LaunchctlError">
>("@usine/server/LaunchctlError")("LaunchctlError", {
  command: Schema.String,
  service: LaunchdService,
  reason: Schema.String,
}) {}

export const configuredLaunchdService = Config.option(
  Config.schema(LaunchdService, "USINE_LAUNCHD_SERVICE"),
).pipe(Effect.orDie);

const LAUNCHCTL_TIMEOUT = "30 seconds";
/** The `launchctl print` exit code for a job that isn't loaded. */
const LAUNCHCTL_UNKNOWN_SERVICE = 113;

export const launchctl = (service: LaunchdService, args: ReadonlyArray<string>) =>
  runCommand("launchctl", args, "/", LAUNCHCTL_TIMEOUT).pipe(
    Effect.mapBoth({
      onSuccess: ({ stdout }) => stdout,
      onFailure: ({ command, reason }) => LaunchctlError.make({ command, service, reason }),
    }),
  );

interface LaunchdState {
  readonly pid: Option.Option<number>;
  readonly state: string;
}

/** Returns `None` only when launchd reports that the job isn't loaded. */
export const launchdState = Effect.fn("Instance.launchdState")(function* (service: LaunchdService) {
  yield* Effect.annotateCurrentSpan({ service });
  const { exitCode, stdout } = yield* runCommand(
    "launchctl",
    ["print", service],
    "/",
    LAUNCHCTL_TIMEOUT,
    [LAUNCHCTL_UNKNOWN_SERVICE],
  ).pipe(
    Effect.mapError(({ command, reason }) => LaunchctlError.make({ command, service, reason })),
  );
  if (exitCode === LAUNCHCTL_UNKNOWN_SERVICE) {
    yield* Effect.logDebug("The launchd job isn't loaded", { service });
    return Option.none<LaunchdState>();
  }
  const pid = Option.fromNullishOr(/^\s*pid = ([0-9]+)\s*$/mu.exec(stdout)?.[1]).pipe(
    Option.flatMap(Schema.decodeOption(Schema.FiniteFromString)),
  );
  const state = /^\s*state = (.+)$/mu.exec(stdout)?.[1]?.trim() ?? "unknown";
  const exited = /^\s*last (?:exit code|terminating signal) = /mu.test(stdout);
  return Option.some<LaunchdState>({
    pid,
    state: Option.isNone(pid) && exited && state === "spawn scheduled" ? "auto-restart" : state,
  });
});

export const supervisingLaunchdService = Effect.fn("Instance.supervisingLaunchdService")(function* (
  pid: ProcessId,
  service: Option.Option<LaunchdService>,
) {
  if (Option.isNone(service)) return Option.none<LaunchdService>();
  yield* Effect.annotateCurrentSpan({ pid, service: service.value });
  const state = yield* launchdState(service.value);
  if (Option.exists(state, (job) => Option.contains(job.pid, pid))) return service;
  yield* Effect.logInfo("The launchd job doesn't supervise the instance process", {
    pid,
    service: service.value,
  });
  return Option.none<LaunchdService>();
});

export const launchdPlist = Effect.fn("Instance.launchdPlist")(function* (service: LaunchdService) {
  const home = yield* Config.String("HOME").pipe(Effect.orDie);
  const path = yield* Path.Path;
  return path.join(
    home,
    "Library",
    "LaunchAgents",
    `${service.slice(service.lastIndexOf("/") + 1)}.plist`,
  );
});

export const startLaunchdService = Effect.fn("Instance.startLaunchdService")(function* (
  service: LaunchdService,
) {
  yield* Effect.annotateCurrentSpan({ service });
  const state = yield* launchdState(service);
  if (Option.isNone(state)) {
    const plist = yield* launchdPlist(service);
    yield* launchctl(service, ["bootstrap", service.slice(0, service.lastIndexOf("/")), plist]);
  }
  yield* launchctl(service, ["kickstart", service]);
  yield* Effect.logInfo("Started the launchd job", { service });
});
