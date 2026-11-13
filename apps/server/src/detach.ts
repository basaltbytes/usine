// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { InstanceDirectory } from "@usine/core/instance";
import {
  type Brand,
  Console,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Option,
  Schedule,
  Schema,
} from "effect";
import { DEFAULT_LIFECYCLE_TIMEOUT_SECONDS, Port, SERVER_HOST, type UpCommand } from "./cli.ts";
import { InstanceInUseError } from "./instance/lock.ts";
import { type InstanceLaunch, ProcessId, currentLaunch, instanceFiles } from "./instance/record.ts";
import { servesRoutes } from "./instance/operator-api.ts";
import { probeInstance } from "./instance/state.ts";
import { configuredLaunchdService } from "./instance/launchd.ts";
import {
  ServiceUnit,
  type ServiceError,
  startService,
  stopService,
  serviceState,
  serviceOutput,
} from "./instance/service.ts";

const READY_POLL_INTERVAL = "250 millis";
/** Spaces service-manager queries during startup. */
const UNIT_POLL_INTERVAL = "500 millis";
const LOG_TAIL_LINES = 20;
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * A `usine up` started in the background exited before it listened, or stopped writing to its log
 * without listening.
 */
export class DetachedStartError extends Schema.TaggedError<
  DetachedStartError,
  Brand.Brand<"@usine/server/detach/DetachedStartError">
>("@usine/server/DetachedStartError")("DetachedStartError", {
  /**
   * `exited` if the process ended. `silent` if it still runs, but neither listened nor wrote to
   * its log for `timeout`.
   */
  outcome: Schema.Literals(["exited", "silent"]),
  pid: Schema.Option(ProcessId),
  /** How the process ended, such as `status 1` or `SIGKILL`. */
  exit: Schema.Option(Schema.String),
  timeout: Schema.Duration,
  port: Port,
  log: Schema.String,
  /** The last lines that the process wrote to the log after it started. */
  tail: Schema.String,
}) {}

/** The log file couldn't be opened, or the process couldn't be spawned. */
export class DetachedSpawnError extends Schema.TaggedError<
  DetachedSpawnError,
  Brand.Brand<"@usine/server/detach/DetachedSpawnError">
>("@usine/server/DetachedSpawnError")("DetachedSpawnError", {
  command: Schema.String,
  reason: Schema.String,
}) {}

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const launchArguments = (launch: InstanceLaunch): ReadonlyArray<string> => {
  const args = [
    ...launch.nodeOptions,
    launch.script,
    "up",
    "--port",
    String(launch.port),
    "--log-level",
    launch.logLevel.toLowerCase(),
  ];
  if (Option.isSome(launch.origin)) args.push("--origin", launch.origin.value);
  if (launch.allowVolatileInstance) args.push("--allow-volatile-instance");
  return args;
};

class LogReadError extends Schema.TaggedError<LogReadError, { readonly Brand: unique symbol }>()(
  "LogReadError",
  {
    cause: Schema.Defect(),
  },
) {}

/** Returns the last lines of `log` after byte `offset`. */
const logTail = (log: string, offset: number) =>
  Effect.try({
    try: () => {
      const descriptor = openSync(log, "r");
      try {
        const size = fstatSync(descriptor).size;
        const start = Math.max(offset, size - LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(Math.max(0, size - start));
        readSync(descriptor, buffer, 0, buffer.length, start);
        return buffer.toString("utf8").trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n");
      } finally {
        closeSync(descriptor);
      }
    },
    catch: (cause) => LogReadError.make({ cause }),
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("Could not read the instance log", { log, cause }),
    ),
    Effect.orElseSucceed(() => ""),
  );

/** A `usine up` that `startDetached` started and that answers on its port. */
export class StartedInstance extends Schema.Class<
  StartedInstance,
  Brand.Brand<"@usine/server/detach/StartedInstance">
>("@usine/server/StartedInstance")({
  pid: ProcessId,
  port: Port,
  /** The service that started the process, whose manager captures its output. */
  unit: Schema.Option(ServiceUnit).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none<ServiceUnit>())),
  ),
}) {}

type StartOutcome =
  | { readonly _tag: "Listening"; readonly started: StartedInstance }
  | { readonly _tag: "Exited"; readonly exit: string }
  | { readonly _tag: "Silent" };

/**
 * Starts `usine up` in the background with `launch`, in its own session and with its output
 * appended to `.usine/usine.log`. Waits until the new process holds the instance and serves its
 * setup or runtime routes, not the startup responses. A usine version that writes only
 * `.usine/instance.pid` also counts. Fails with `DetachedStartError` if the process exits first,
 * or if it neither answers nor writes to the log for `timeout`.
 */
export const startDetached = Effect.fn("Cli.startDetached")(function* (
  directory: InstanceDirectory,
  launch: InstanceLaunch,
  timeout: Duration.Duration,
) {
  const files = instanceFiles(directory);
  const fileSystem = yield* FileSystem.FileSystem;
  const args = launchArguments(launch);
  yield* Effect.annotateCurrentSpan({
    instanceDirectory: directory,
    port: launch.port,
    script: launch.script,
  });
  const spawnError = (cause: unknown) =>
    DetachedSpawnError.make({ command: [launch.node, ...args].join(" "), reason: reasonOf(cause) });
  yield* fileSystem
    .makeDirectory(files.folder, { recursive: true })
    .pipe(Effect.mapError(spawnError));
  const logSize = fileSystem.stat(files.log).pipe(
    Effect.map(({ size }) => Number(size)),
    Effect.orElseSucceed(() => 0),
  );
  const offset = yield* logSize;
  const ended = yield* Deferred.make<string>();
  const child = yield* Effect.try({
    try: () => {
      const output = openSync(files.log, "a", 0o600);
      try {
        return spawn(launch.node, args, {
          cwd: directory,
          detached: true,
          stdio: ["ignore", output, output],
        });
      } finally {
        closeSync(output);
      }
    },
    catch: spawnError,
  });
  child.once("exit", (code, signal) => {
    Deferred.doneUnsafe(ended, Effect.succeed(signal ?? `status ${code ?? "unknown"}`));
  });
  child.once("error", (error) => {
    Deferred.doneUnsafe(ended, Effect.succeed(error.message));
  });
  child.unref();
  const pid = Schema.decodeUnknownOption(ProcessId)(child.pid);
  yield* Effect.logInfo("Started usine up in the background", {
    pid: Option.getOrUndefined(pid),
    log: files.log,
    port: launch.port,
  });

  // Polls HTTP first: the lock probe takes a read lock, and by the time the server answers, the new
  // process has held the instance lock for a while.
  const listening = Effect.gen(function* () {
    while (true) {
      if (yield* servesRoutes(launch.port)) {
        const state = yield* probeInstance(directory);
        const holder =
          state._tag === "Running"
            ? Option.some(state.record.pid)
            : state._tag === "Unrecorded"
              ? state.pid
              : Option.none();
        if (Option.isSome(pid) && Option.contains(holder, pid.value)) {
          const started = StartedInstance.make({ pid: pid.value, port: launch.port });
          return { _tag: "Listening", started } satisfies StartOutcome;
        }
      }
      yield* Effect.sleep(READY_POLL_INTERVAL);
    }
  });
  const exited = Deferred.await(ended).pipe(
    Effect.map((exit) => ({ _tag: "Exited", exit }) satisfies StartOutcome),
  );
  /** Returns `Silent` once the log size, starting from `bytes`, stays the same for `timeout`. */
  const silence = (bytes: number): Effect.Effect<StartOutcome> =>
    logSize.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(READY_POLL_INTERVAL),
        until: (size) => size !== bytes,
      }),
      Effect.timeoutOption(timeout),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed({ _tag: "Silent" } satisfies StartOutcome),
          onSome: silence,
        }),
      ),
    );
  // Never completes. At `timeout`, a log that grew since the spawn restarted `silence`, so the
  // command says that it keeps waiting.
  const stillStarting = Effect.sleep(timeout).pipe(
    Effect.andThen(logSize),
    Effect.flatMap((size) =>
      size === offset
        ? Effect.void
        : Effect.logInfo(
            "The background usine up isn't listening yet; waiting while it writes to its log",
            {
              pid: Option.getOrUndefined(pid),
              port: launch.port,
              log: files.log,
              timeoutSeconds: Duration.toSeconds(timeout),
            },
          ),
    ),
    Effect.andThen(Effect.never),
  );
  // `raceAllFirst` ends the wait on the first result, including a failed readiness probe.
  // `raceAll` would hide that failure until the log fell silent.
  const outcome = yield* Effect.raceAllFirst([listening, exited, silence(offset), stillStarting]);
  if (outcome._tag === "Listening") {
    yield* Effect.logInfo("The background usine up is listening", {
      pid: outcome.started.pid,
      port: launch.port,
    });
    return outcome.started;
  }
  const tail = yield* logTail(files.log, offset);
  const error = DetachedStartError.make({
    outcome: outcome._tag === "Exited" ? "exited" : "silent",
    pid,
    exit: outcome._tag === "Exited" ? Option.some(outcome.exit) : Option.none(),
    timeout,
    port: launch.port,
    log: files.log,
    tail,
  });
  yield* Effect.logWarning("The background usine up did not start listening", {
    outcome: error.outcome,
    pid: Option.getOrUndefined(pid),
    exit: Option.getOrUndefined(error.exit),
  });
  return yield* error;
});

/** Returns the line that names a started instance's address, PID, and output. */
export const startedMessage = ({ pid, port, unit }: StartedInstance): string =>
  Option.match(unit, {
    onNone: () =>
      `usine is running at http://${SERVER_HOST}:${port} (pid ${pid}), with its output in .usine/usine.log.`,
    onSome: (service) =>
      `usine is running at http://${SERVER_HOST}:${port} (pid ${pid}) in ${service}, with its output at ${serviceOutput(service)}.`,
  });

/**
 * A supervised start failed before `usine up` answered, or did not answer within the timeout.
 */
export class ServiceStartError extends Schema.TaggedError<
  ServiceStartError,
  Brand.Brand<"@usine/server/detach/ServiceStartError">
>("@usine/server/ServiceStartError")("ServiceStartError", {
  unit: ServiceUnit,
  /** `failed` if the service stopped or waits to restart, `silent` if it runs but didn't answer. */
  outcome: Schema.Literals(["failed", "silent"]),
  /** The manager's active state and detail, such as `activating (auto-restart)`. */
  state: Schema.String,
  timeout: Schema.Duration,
}) {}

/** The service states that end a start before `usine up` answers. */
const ENDED_STATES: ReadonlySet<string> = new Set(["failed", "inactive", "deactivating"]);

/**
 * Cancels a supervisor's pending retry after a failed start. Logs cleanup failures while
 * preserving the original start error.
 */
const cancelPendingRestart = Effect.fn("Cli.cancelPendingRestart")(
  function* (unit: ServiceUnit, failure: ServiceError) {
    const state = yield* serviceState(unit);
    if (state.sub !== "auto-restart" && state.sub !== "waiting") {
      yield* Effect.logWarning("Service start failed; the service doesn't wait to restart", {
        unit,
        state: `${state.active} (${state.sub})`,
        reason: failure.reason,
      });
      return;
    }
    yield* Effect.logWarning("Service start failed and the service waits to restart; stopping it", {
      unit,
      reason: failure.reason,
    });
    yield* stopService(unit);
  },
  Effect.catchTags({
    SystemctlError: (error) =>
      Effect.logWarning("Could not check or cancel the service restart after a failed start", {
        unit: error.unit,
        command: error.command,
        reason: error.reason,
      }),
    LaunchctlError: (error) =>
      Effect.logWarning("Could not check or cancel the launchd restart", {
        service: error.service,
        command: error.command,
        reason: error.reason,
      }),
  }),
);

/**
 * Starts a supervised instance and waits for a different process to own its lock and answer.
 * Cancels pending supervisor retries when startup fails. A timeout leaves a running service up.
 */
export const startUnit = Effect.fn("Cli.startUnit")(function* (
  directory: InstanceDirectory,
  unit: ServiceUnit,
  previous: ProcessId,
  timeout: Duration.Duration,
) {
  yield* Effect.annotateCurrentSpan({ instanceDirectory: directory, unit });
  yield* startService(unit).pipe(Effect.tapError((failure) => cancelPendingRestart(unit, failure)));
  yield* Effect.logInfo("Started the instance's service", { unit });
  let last = "unknown";
  const listening = Effect.gen(function* () {
    while (true) {
      const state = yield* probeInstance(directory);
      if (
        state._tag === "Running" &&
        state.record.pid !== previous &&
        (yield* servesRoutes(state.record.launch.port))
      ) {
        return StartedInstance.make({
          pid: state.record.pid,
          port: state.record.launch.port,
          unit: Option.some(unit),
        });
      }
      const { active, sub } = yield* serviceState(unit);
      last = `${active} (${sub})`;
      if (ENDED_STATES.has(active) || sub === "auto-restart") {
        yield* Effect.logWarning("The instance's service ended before usine up answered", {
          unit,
          state: last,
        });
        // Cancels the restart, so that a start that fails, such as a failed migration, doesn't repeat.
        if (sub === "auto-restart" || sub === "waiting") yield* stopService(unit);
        return yield* ServiceStartError.make({ unit, outcome: "failed", state: last, timeout });
      }
      yield* Effect.sleep(UNIT_POLL_INTERVAL);
    }
  });
  const started = yield* Effect.timeoutOption(listening, timeout);
  if (Option.isSome(started)) {
    yield* Effect.logInfo("The instance's service is listening", {
      unit,
      pid: started.value.pid,
      port: started.value.port,
    });
    return started.value;
  }
  yield* Effect.logWarning("The instance's service didn't answer before the timeout", {
    unit,
    state: last,
    timeoutSeconds: Duration.toSeconds(timeout),
  });
  return yield* ServiceStartError.make({ unit, outcome: "silent", state: last, timeout });
});

/**
 * Starts the instance after `previous` stops, using its supervisor or a detached process.
 */
export const startAgain = Effect.fn("Cli.startAgain")(function* (
  directory: InstanceDirectory,
  launch: InstanceLaunch,
  unit: Option.Option<ServiceUnit>,
  previous: ProcessId,
  timeout: Duration.Duration,
) {
  return yield* Option.match(unit, {
    onNone: () => startDetached(directory, launch, timeout),
    onSome: (service) => startUnit(directory, service, previous, timeout),
  });
});

/** Starts `usine up` in the background in the instance folder, unless it runs already. */
export const upDetached = Effect.fn("Cli.upDetached")(function* (
  directory: InstanceDirectory,
  command: UpCommand,
) {
  const state = yield* probeInstance(directory);
  if (state._tag !== "Stopped") {
    return yield* InstanceInUseError.make({
      directory,
      holder: state._tag === "Running" ? Option.some(state.record.pid) : state.pid,
    });
  }
  const launch = yield* currentLaunch(command);
  const service = yield* configuredLaunchdService;
  const started = yield* startAgain(
    directory,
    launch,
    service,
    ProcessId.make(process.pid),
    Duration.seconds(DEFAULT_LIFECYCLE_TIMEOUT_SECONDS),
  );
  yield* Console.log(startedMessage(started));
});
