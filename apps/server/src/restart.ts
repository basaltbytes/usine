import type { InstanceDirectory } from "@usine/core/instance";
import { Console, Effect, Option } from "effect";
import {
  type CliEnvironment,
  type CliUsageError,
  type LifecycleOptions,
  environmentUp,
} from "./cli.ts";
import { startDetached, startedMessage } from "./detach.ts";
import { listRuns } from "./instance/operator-api.ts";
import { listeningPorts } from "./instance/ports.ts";
import {
  type InstanceLaunch,
  type InstanceRecord,
  type ProcessId,
  currentLaunch,
} from "./instance/record.ts";
import { probeInstance } from "./instance/state.ts";
import {
  InstanceNotRunningError,
  UnrecordedInstanceError,
  refuseLiveAttempts,
  refuseMissingEnvironment,
  stopProcess,
} from "./stop.ts";

/**
 * Returns the launch of a `usine up --detach` without flags from this CLI, which `usine restart`
 * starts for an instance without a readable record.
 */
export const fallbackLaunch = (environment: CliEnvironment) =>
  environmentUp(environment).pipe(
    Effect.flatMap(({ port, logLevel, allowVolatileInstance }) =>
      currentLaunch(port, logLevel, allowVolatileInstance),
    ),
  );

/**
 * Returns the port on which the process answers the operator API, or `None` if none of its ports
 * does. Fails if the OS can't list its ports.
 */
const operatorPort = Effect.fn("Cli.operatorPort")(function* (pid: ProcessId) {
  const ports = yield* listeningPorts(pid);
  const port = yield* Effect.findFirst(ports, (port) =>
    listRuns(port).pipe(
      Effect.tapError((error) =>
        Effect.logDebug("A port of the instance process doesn't answer the operator API", {
          pid,
          port,
          reason: error.reason,
        }),
      ),
      Effect.isSuccess,
    ),
  );
  yield* Effect.annotateCurrentSpan({ pid, ports, port: Option.getOrUndefined(port) });
  return port;
});

/**
 * Returns the process that `usine restart` stops, its record if readable, the port on which the
 * checks ask it, and the next launch.
 */
const restartTarget = Effect.fn("Cli.restartTarget")(function* (
  directory: InstanceDirectory,
  fallback: Effect.Effect<InstanceLaunch, CliUsageError>,
) {
  yield* Effect.annotateCurrentSpan({ instanceDirectory: directory });
  const state = yield* probeInstance(directory);
  if (state._tag === "Stopped") {
    yield* Effect.logInfo("Refusing to restart: usine is not running in the instance folder", {
      instanceDirectory: directory,
    });
    return yield* new InstanceNotRunningError({ command: "restart", directory });
  }
  if (state._tag === "Running") {
    const { record } = state;
    yield* Effect.annotateCurrentSpan({ pid: record.pid });
    return {
      pid: record.pid,
      record: Option.some(record),
      port: Option.some(record.launch.port),
      launch: record.launch,
    };
  }
  if (Option.isNone(state.pid)) {
    yield* Effect.logInfo(
      "Refusing to restart: a process holds the instance lock, but the pid file names no running process",
      { instanceDirectory: directory },
    );
    return yield* new UnrecordedInstanceError({ command: "restart", directory, pid: state.pid });
  }
  const pid = state.pid.value;
  yield* Effect.annotateCurrentSpan({ pid });
  const launch = yield* fallback;
  const port = yield* operatorPort(pid).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Refusing to restart: the ports of the instance process are unknown", {
        pid,
        reason: error.reason,
      }),
    ),
  );
  yield* Effect.logInfo("Restarting an instance without a readable record with this CLI's launch", {
    pid,
    port: Option.getOrUndefined(port),
    launchPort: launch.port,
    script: launch.script,
  });
  yield* Console.log(
    Option.match(port, {
      onNone: () =>
        `usine (pid ${pid}) runs without a readable .usine/instance.json and answers on no port, so usine restart can't check its running attempts or gateway variables. usine restart starts usine up as usine up --detach would, on port ${launch.port}.`,
      onSome: (current) =>
        `usine (pid ${pid}) runs without a readable .usine/instance.json and answers on port ${current}. usine restart checks it there, then starts usine up as usine up --detach would, on port ${launch.port}.`,
    }),
  );
  return { pid, record: Option.none<InstanceRecord>(), port, launch };
});

/**
 * Stops the `usine up` of the instance folder and starts it again in the background, with the
 * Node.js binary, entry point, port, and flags that it recorded. Without a readable record, as from
 * a usine version that writes only `.usine/instance.pid`, stops the process in that file and starts
 * `fallback`. The checks then ask the port on which that process answers, and pass if none does.
 * Fails with `ListeningPortsError`, before any signal, if the OS can't list that process's ports.
 */
export const restart = Effect.fn("Cli.restart")(function* (
  directory: InstanceDirectory,
  options: LifecycleOptions,
  fallback: Effect.Effect<InstanceLaunch, CliUsageError>,
) {
  const { pid, record, port, launch } = yield* restartTarget(directory, fallback);
  if (Option.isSome(port)) {
    yield* refuseMissingEnvironment("restart", port.value);
    yield* refuseLiveAttempts("restart", port.value, options.force);
  } else {
    yield* Effect.logWarning(
      "Skipping the restart checks: the instance process answers on no port",
      {
        pid,
      },
    );
  }
  yield* stopProcess("restart", pid, record, options);
  const started = yield* startDetached(directory, launch, options.timeout);
  yield* Console.log(startedMessage(started));
});
