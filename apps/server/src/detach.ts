import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { InstanceDirectory } from "@usine/core/instance";
import { Console, Deferred, Duration, Effect, FileSystem, Option, Schedule, Schema } from "effect";
import { DEFAULT_LIFECYCLE_TIMEOUT_SECONDS, Port, SERVER_HOST, type UpCommand } from "./cli.ts";
import { InstanceInUseError } from "./instance/lock.ts";
import { type InstanceLaunch, ProcessId, currentLaunch, instanceFiles } from "./instance/record.ts";
import { answers } from "./instance/operator-api.ts";
import { probeInstance } from "./instance/state.ts";
import { SystemdUnit, systemctl, unitState } from "./instance/systemd.ts";

const READY_POLL_INTERVAL = "250 millis";
/** Spaces the checks of a starting systemd service, each of which runs `systemctl show`. */
const UNIT_POLL_INTERVAL = "500 millis";
const LOG_TAIL_LINES = 20;
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * A `usine up` started in the background exited before it listened, or stopped writing to its log
 * without listening.
 */
export class DetachedStartError extends Schema.TaggedError<DetachedStartError>(
  "@usine/server/DetachedStartError",
)("DetachedStartError", {
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
export class DetachedSpawnError extends Schema.TaggedError<DetachedSpawnError>(
  "@usine/server/DetachedSpawnError",
)("DetachedSpawnError", { command: Schema.String, reason: Schema.String }) {}

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
  if (Option.isSome(launch.listen)) args.push("--listen", launch.listen.value);
  if (launch.allowVolatileInstance) args.push("--allow-volatile-instance");
  return args;
};

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
    catch: (cause) => cause,
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("Could not read the instance log", { log, cause }),
    ),
    Effect.orElseSucceed(() => ""),
  );

/** A `usine up` that `startDetached` started and that answers on its port. */
export class StartedInstance extends Schema.Class<StartedInstance>("@usine/server/StartedInstance")(
  {
    pid: ProcessId,
    port: Port,
    /** The systemd service that started the process, whose journal has its output. */
    unit: Schema.Option(SystemdUnit).pipe(
      Schema.withConstructorDefault(Effect.succeed(Option.none<SystemdUnit>())),
    ),
  },
) {}

type StartOutcome =
  | { readonly _tag: "Listening"; readonly started: StartedInstance }
  | { readonly _tag: "Exited"; readonly exit: string }
  | { readonly _tag: "Silent" };

/**
 * Starts `usine up` in the background with `launch`, in its own session and with its output
 * appended to `.usine/usine.log`. Waits until the new process holds the instance and answers HTTP
 * requests. A usine version that writes only `.usine/instance.pid` also counts. Fails with
 * `DetachedStartError` if the process exits first, or if it neither answers nor writes to the log
 * for `timeout`.
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
    new DetachedSpawnError({ command: [launch.node, ...args].join(" "), reason: reasonOf(cause) });
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
      if (yield* answers(launch.port)) {
        const state = yield* probeInstance(directory);
        const holder =
          state._tag === "Running"
            ? Option.some(state.record.pid)
            : state._tag === "Unrecorded"
              ? state.pid
              : Option.none();
        if (Option.isSome(pid) && Option.contains(holder, pid.value)) {
          const started = new StartedInstance({ pid: pid.value, port: launch.port });
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
  const error = new DetachedStartError({
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
      `usine is running at http://${SERVER_HOST}:${port} (pid ${pid}) in ${service}, with its output in the journal: journalctl -u ${service}.`,
  });

/**
 * The systemd service that `systemctl start` started failed before its `usine up` answered, or its
 * `usine up` didn't answer within the timeout.
 */
export class SystemdStartError extends Schema.TaggedError<SystemdStartError>(
  "@usine/server/SystemdStartError",
)("SystemdStartError", {
  unit: SystemdUnit,
  /** `failed` if the service stopped or waits to restart, `silent` if it runs but didn't answer. */
  outcome: Schema.Literals(["failed", "silent"]),
  /** The service's `ActiveState` and `SubState`, such as `activating (auto-restart)`. */
  state: Schema.String,
  timeout: Schema.Duration,
}) {}

/** The service states that end a start before `usine up` answers. */
const ENDED_STATES: ReadonlySet<string> = new Set(["failed", "inactive", "deactivating"]);

/**
 * Starts the instance's systemd service with `systemctl start`, and waits until a process other
 * than `previous` holds the instance and answers on its recorded port. Fails with
 * `SystemdStartError` if the service stops or waits to restart first, and then stops it, or after
 * `timeout`, when the service keeps running.
 */
export const startUnit = Effect.fn("Cli.startUnit")(function* (
  directory: InstanceDirectory,
  unit: SystemdUnit,
  previous: ProcessId,
  timeout: Duration.Duration,
) {
  yield* Effect.annotateCurrentSpan({ instanceDirectory: directory, unit });
  yield* systemctl(unit, ["start"]);
  yield* Effect.logInfo("Started the instance's systemd service", { unit });
  let last = "unknown";
  const listening = Effect.gen(function* () {
    while (true) {
      const state = yield* probeInstance(directory);
      if (
        state._tag === "Running" &&
        state.record.pid !== previous &&
        (yield* answers(state.record.launch.port))
      ) {
        return new StartedInstance({
          pid: state.record.pid,
          port: state.record.launch.port,
          unit: Option.some(unit),
        });
      }
      const { active, sub } = yield* unitState(unit);
      last = `${active} (${sub})`;
      if (ENDED_STATES.has(active) || sub === "auto-restart") {
        yield* Effect.logWarning("The instance's systemd service ended before usine up answered", {
          unit,
          state: last,
        });
        // Cancels the restart, so that a start that fails, such as a failed migration, doesn't repeat.
        if (sub === "auto-restart") yield* systemctl(unit, ["stop", "--no-block"]);
        return yield* new SystemdStartError({ unit, outcome: "failed", state: last, timeout });
      }
      yield* Effect.sleep(UNIT_POLL_INTERVAL);
    }
  });
  const started = yield* Effect.timeoutOption(listening, timeout);
  if (Option.isSome(started)) {
    yield* Effect.logInfo("The instance's systemd service is listening", {
      unit,
      pid: started.value.pid,
      port: started.value.port,
    });
    return started.value;
  }
  yield* Effect.logWarning("The instance's systemd service didn't answer before the timeout", {
    unit,
    state: last,
    timeoutSeconds: Duration.toSeconds(timeout),
  });
  return yield* new SystemdStartError({ unit, outcome: "silent", state: last, timeout });
});

/**
 * Starts the instance again after `previous` stopped: with `systemctl start` if `unit` ran it, else
 * in the background with `launch`.
 */
export const startAgain = Effect.fn("Cli.startAgain")(function* (
  directory: InstanceDirectory,
  launch: InstanceLaunch,
  unit: Option.Option<SystemdUnit>,
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
    return yield* new InstanceInUseError({
      directory,
      holder: state._tag === "Running" ? Option.some(state.record.pid) : state.pid,
    });
  }
  const launch = yield* currentLaunch(command);
  const started = yield* startDetached(
    directory,
    launch,
    Duration.seconds(DEFAULT_LIFECYCLE_TIMEOUT_SECONDS),
  );
  yield* Console.log(startedMessage(started));
});
