import type { InstanceDirectory } from "@usine/core/instance";
import { RunId } from "@usine/core/run";
import { Config, Console, Duration, Effect, Option, Schema } from "effect";
import type { LifecycleOptions, Port } from "./cli.ts";
import { type InstanceRecord, ProcessId } from "./instance/record.ts";
import { gatewayTokenVariables, hasLiveAttempt, listRuns } from "./instance/operator-api.ts";
import { probeInstance, processAlive, signalProcess } from "./instance/state.ts";
import { SystemdUnit, supervisingUnit, systemctl } from "./instance/systemd.ts";

const EXIT_POLL_INTERVAL = "200 millis";
/** Separates the two signals of `--force`, so that the OS doesn't merge them into one. */
const SECOND_SIGNAL_DELAY = "250 millis";
/** How long `--force` waits for the process to exit after `SIGKILL`. */
const KILL_EXIT_TIMEOUT = Duration.seconds(5);

/** The CLI command that stops the instance. */
export const LifecycleCommandName = Schema.Literals(["stop", "restart", "upgrade"]);
export type LifecycleCommandName = typeof LifecycleCommandName.Type;

/** The instance process didn't exit within the timeout. Its drain continues. */
export class StopTimeoutError extends Schema.TaggedError<StopTimeoutError>(
  "@usine/server/StopTimeoutError",
)("StopTimeoutError", {
  command: LifecycleCommandName,
  pid: ProcessId,
  timeout: Schema.Duration,
  /** The Runs whose Attempts were live when the stop started. */
  runs: Schema.Array(RunId),
  /** The systemd service that runs the instance, which `systemctl start` starts again. */
  unit: Schema.Option(SystemdUnit),
}) {}

/** The instance process still ran `timeout` after `--force` sent it `SIGKILL`. */
export class KillTimeoutError extends Schema.TaggedError<KillTimeoutError>(
  "@usine/server/KillTimeoutError",
)("KillTimeoutError", {
  command: LifecycleCommandName,
  pid: ProcessId,
  timeout: Schema.Duration,
}) {}

/** No `usine up` runs in the instance folder. */
export class InstanceNotRunningError extends Schema.TaggedError<InstanceNotRunningError>(
  "@usine/server/InstanceNotRunningError",
)("InstanceNotRunningError", { command: LifecycleCommandName, directory: Schema.String }) {}

/** A process holds the instance lock without an instance record, so its launch is unknown. */
export class UnrecordedInstanceError extends Schema.TaggedError<UnrecordedInstanceError>(
  "@usine/server/UnrecordedInstanceError",
)("UnrecordedInstanceError", {
  command: LifecycleCommandName,
  directory: Schema.String,
  pid: Schema.Option(ProcessId),
}) {}

/** Runs have live Attempts, and the operator didn't pass `--force`. */
export class LiveAttemptsError extends Schema.TaggedError<LiveAttemptsError>(
  "@usine/server/LiveAttemptsError",
)("LiveAttemptsError", { command: LifecycleCommandName, runs: Schema.Array(RunId) }) {}

/**
 * Neither the shell that would start the new `usine up` nor `.env` sets variables that its startup
 * needs.
 */
export class MissingEnvironmentError extends Schema.TaggedError<MissingEnvironmentError>(
  "@usine/server/MissingEnvironmentError",
)("MissingEnvironmentError", {
  command: LifecycleCommandName,
  variables: Schema.Array(Schema.NonEmptyString),
}) {}

/**
 * Fails with `MissingEnvironmentError` if the current `ConfigProvider` lacks a gateway admin token
 * variable of the instance that listens on `port`. The new `usine up` inherits this process's
 * environment and reads the instance folder's `.env`, and doesn't start without them.
 */
export const refuseMissingEnvironment = Effect.fn("Cli.refuseMissingEnvironment")(function* (
  command: LifecycleCommandName,
  port: Port,
) {
  const names = yield* gatewayTokenVariables(port).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Could not read the gateway token variables of the instance", {
        url: error.url,
        reason: error.reason,
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  const missing: Array<string> = [];
  for (const name of names) {
    const value = yield* Config.option(Config.string(name)).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(value)) missing.push(name);
  }
  if (missing.length === 0) return;
  yield* Effect.logInfo("Refusing to stop the instance: the new process would lack variables", {
    command,
    variables: missing,
  });
  return yield* new MissingEnvironmentError({ command, variables: missing });
});

/** Returns the Runs with a live Attempt, or none if the operator API doesn't answer. */
const liveRuns = (port: Port) =>
  listRuns(port).pipe(
    Effect.map((runs) => runs.filter(hasLiveAttempt).map(({ id }) => id)),
    Effect.tapError((error) =>
      Effect.logWarning("Could not list the running runs; the drain still waits for them", {
        url: error.url,
        reason: error.reason,
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<RunId> => []),
  );

/**
 * Fails with `LiveAttemptsError` if a Run of the instance that listens on `port` has a live
 * Attempt, unless `force` is set.
 */
export const refuseLiveAttempts = Effect.fn("Cli.refuseLiveAttempts")(function* (
  command: LifecycleCommandName,
  port: Port,
  force: boolean,
) {
  if (force) return;
  const runs = yield* liveRuns(port);
  if (runs.length === 0) return;
  yield* Effect.logInfo("Refusing to stop the instance while runs have live attempts", {
    command,
    runs,
  });
  return yield* new LiveAttemptsError({ command, runs });
});

/** Returns `true` once the process has exited, or `false` after `timeout`. */
const waitForExit = (pid: ProcessId, timeout: Duration.Duration) =>
  Effect.gen(function* () {
    while (yield* processAlive(pid)) yield* Effect.sleep(EXIT_POLL_INTERVAL);
  }).pipe(Effect.timeoutOption(timeout), Effect.map(Option.isSome));

/**
 * Sends `SIGKILL` to a process that a forced stop didn't end within `timeout`, and waits for it to
 * exit.
 */
const killProcess = Effect.fn("Cli.killProcess")(function* (
  command: LifecycleCommandName,
  pid: ProcessId,
  timeout: Duration.Duration,
) {
  yield* Effect.annotateCurrentSpan({ command, pid });
  yield* signalProcess(pid, "SIGKILL");
  yield* Console.log(
    `usine (pid ${pid}) did not exit within ${Duration.format(timeout)}. Sent SIGKILL: the next start reattaches the running attempts.`,
  );
  if (yield* waitForExit(pid, KILL_EXIT_TIMEOUT)) return;
  yield* Effect.logWarning("The instance process did not exit after SIGKILL", {
    command,
    pid,
    timeoutSeconds: Duration.toSeconds(KILL_EXIT_TIMEOUT),
  });
  return yield* new KillTimeoutError({ command, pid, timeout: KILL_EXIT_TIMEOUT });
});

/**
 * Starts the drain of the instance process and waits for the process to exit: through
 * `systemctl stop --no-block` if `unit` runs it, so that systemd doesn't restart it, else with
 * `SIGTERM`. With `force`, sends a second `SIGTERM`, which ends the drain without waiting for
 * running Attempts, and sends `SIGKILL` if the process still runs after the timeout. Doesn't repeat
 * the first signal to a process that records that it is stopping.
 */
export const stopProcess = Effect.fn("Cli.stopProcess")(function* (
  command: LifecycleCommandName,
  pid: ProcessId,
  record: Option.Option<InstanceRecord>,
  unit: Option.Option<SystemdUnit>,
  options: LifecycleOptions,
) {
  yield* Effect.annotateCurrentSpan({
    command,
    pid,
    force: options.force,
    unit: Option.getOrUndefined(unit),
  });
  const stopping = Option.exists(record, ({ stoppingSince }) => stoppingSince !== undefined);
  const runs = Option.isSome(record) ? yield* liveRuns(record.value.launch.port) : [];
  if (stopping) {
    yield* Console.log(`usine (pid ${pid}) is already stopping. Waiting for it to exit.`);
  } else if (Option.isSome(unit)) {
    yield* Console.log(`Stopping usine (pid ${pid}) with systemctl stop ${unit.value}.`);
    yield* systemctl(unit.value, ["stop", "--no-block"]);
    yield* Effect.logInfo("Asked systemd to stop the instance's service", {
      command,
      pid,
      unit: unit.value,
    });
  } else {
    yield* Console.log(`Stopping usine (pid ${pid}).`);
    yield* signalProcess(pid, "SIGTERM");
  }
  if (options.force) {
    yield* Effect.sleep(SECOND_SIGNAL_DELAY);
    if (yield* processAlive(pid)) {
      yield* signalProcess(pid, "SIGTERM");
      yield* Console.log(
        "Sent a second SIGTERM: usine stops without waiting for running attempts, and the next start reattaches them.",
      );
    }
  } else if (runs.length > 0) {
    yield* Console.log(
      `Waiting for the running attempts of ${runs.length === 1 ? "run" : "runs"} ${runs.join(", ")} to end.`,
    );
  }
  if (!(yield* waitForExit(pid, options.timeout))) {
    yield* Effect.logWarning("The instance process did not exit before the timeout", {
      command,
      pid,
      force: options.force,
      timeoutSeconds: Duration.toSeconds(options.timeout),
    });
    if (!options.force) {
      return yield* new StopTimeoutError({ command, pid, timeout: options.timeout, runs, unit });
    }
    yield* killProcess(command, pid, options.timeout);
  }
  yield* Effect.logInfo("The instance process exited", { command, pid });
  yield* Console.log("usine stopped.");
});

/** Stops the `usine up` of the instance folder, and succeeds if none runs. */
export const stop = Effect.fn("Cli.stop")(function* (
  directory: InstanceDirectory,
  options: LifecycleOptions,
) {
  const state = yield* probeInstance(directory);
  if (state._tag === "Stopped") {
    yield* Console.log(`usine is not running in ${directory}.`);
    return;
  }
  if (state._tag === "Running") {
    const { record } = state;
    const unit = yield* supervisingUnit(record.pid, record.systemdUnit);
    return yield* stopProcess("stop", record.pid, Option.some(record), unit, options);
  }
  if (Option.isNone(state.pid)) {
    return yield* new UnrecordedInstanceError({ command: "stop", directory, pid: state.pid });
  }
  return yield* stopProcess("stop", state.pid.value, Option.none(), Option.none(), options);
});
