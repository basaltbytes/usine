import type { InstanceDirectory } from "@usine/core/instance";
import { Console, Effect, Option } from "effect";
import {
  type CliEnvironment,
  type CliUsageError,
  type LifecycleOptions,
  environmentUp,
} from "./cli.ts";
import { startDetached, startedMessage } from "./detach.ts";
import { type InstanceLaunch, type InstanceRecord, currentLaunch } from "./instance/record.ts";
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

/** Returns the process that `usine restart` stops, its record if readable, and the next launch. */
const restartTarget = Effect.fn("Cli.restartTarget")(function* (
  directory: InstanceDirectory,
  fallback: Effect.Effect<InstanceLaunch, CliUsageError>,
) {
  const state = yield* probeInstance(directory);
  if (state._tag === "Stopped") {
    return yield* new InstanceNotRunningError({ command: "restart", directory });
  }
  if (state._tag === "Running") {
    const { record } = state;
    return { pid: record.pid, record: Option.some(record), launch: record.launch };
  }
  if (Option.isNone(state.pid)) {
    return yield* new UnrecordedInstanceError({ command: "restart", directory, pid: state.pid });
  }
  const pid = state.pid.value;
  const launch = yield* fallback;
  yield* Effect.logInfo("Restarting an instance without a readable record with this CLI's launch", {
    pid,
    port: launch.port,
    script: launch.script,
  });
  yield* Console.log(
    `usine (pid ${pid}) runs without a readable .usine/instance.json, so usine restart uses the launch of usine up --detach, on port ${launch.port}.`,
  );
  return { pid, record: Option.none<InstanceRecord>(), launch };
});

/**
 * Stops the `usine up` of the instance folder and starts it again in the background, with the
 * Node.js binary, entry point, port, and flags that it recorded. Without a readable record, as from
 * a usine version that writes only `.usine/instance.pid`, stops the process in that file and starts
 * `fallback`. The checks then ask the fallback's port, and pass if nothing answers there.
 */
export const restart = Effect.fn("Cli.restart")(function* (
  directory: InstanceDirectory,
  options: LifecycleOptions,
  fallback: Effect.Effect<InstanceLaunch, CliUsageError>,
) {
  const { pid, record, launch } = yield* restartTarget(directory, fallback);
  yield* refuseMissingEnvironment("restart", launch.port);
  yield* refuseLiveAttempts("restart", launch.port, options.force);
  yield* stopProcess("restart", pid, record, options);
  const started = yield* startDetached(directory, launch, options.timeout);
  yield* Console.log(startedMessage(started));
});
