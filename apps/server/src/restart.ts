import type { InstanceDirectory } from "@usine/core/instance";
import { Console, Effect, Option } from "effect";
import type { LifecycleOptions } from "./cli.ts";
import { startDetached, startedMessage } from "./detach.ts";
import {
  refuseLiveAttempts,
  refuseMissingEnvironment,
  runningRecord,
  stopProcess,
} from "./stop.ts";

/**
 * Stops the `usine up` of the instance folder and starts it again in the background, with the
 * Node.js binary, entry point, port, and flags that it recorded.
 */
export const restart = Effect.fn("Cli.restart")(function* (
  directory: InstanceDirectory,
  options: LifecycleOptions,
) {
  const record = yield* runningRecord("restart", directory);
  yield* refuseMissingEnvironment("restart", record);
  yield* refuseLiveAttempts("restart", record, options.force);
  yield* stopProcess("restart", record.pid, Option.some(record), options);
  const started = yield* startDetached(directory, record.launch, options.timeout);
  yield* Console.log(startedMessage(started));
});
