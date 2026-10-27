import { Duration, Effect, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const PMSET_TIMEOUT = Duration.seconds(5);

/** The macOS system sleep setting in use, from `pmset -g`. */
interface SystemSleep {
  /** The idle minutes before the system sleeps; 0 if it doesn't. */
  readonly minutes: number;
  /** The processes that prevent sleep now, such as `caffeinate`. */
  readonly preventedBy: ReadonlyArray<string>;
}

/** Matches a line such as ` sleep  1 (sleep prevented by caffeinate, powerd)`. */
const SLEEP_LINE = /^\s*sleep\s+(\d+)(?:\s+\(sleep prevented by ([^)]*)\))?/mu;

const Minutes = Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int));

/** Returns the `sleep` setting in `pmset -g` output, or `None` if it has no `sleep` line. */
const systemSleepOf = (output: string): Option.Option<SystemSleep> => {
  const line = SLEEP_LINE.exec(output);
  if (line === null) return Option.none();
  return Option.map(Schema.decodeUnknownOption(Minutes)(line[1]), (minutes) => ({
    minutes,
    preventedBy: (line[2] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  }));
};

/**
 * Logs a warning if this Mac can sleep while `usine up` runs: system sleep is on, and `caffeinate`
 * doesn't prevent it. A sleep closes the SSH connections to Workers and to the Gateway, and the
 * orchestrator does nothing until the Mac wakes.
 */
export const warnIfSystemSleeps = Effect.fn("Server.warnIfSystemSleeps")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sleep = yield* spawner
    .string(ChildProcess.make("pmset", ["-g"], { stdin: "ignore", stderr: "ignore" }))
    .pipe(
      Effect.timeout(PMSET_TIMEOUT),
      Effect.map(systemSleepOf),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not read the system sleep setting with pmset", { cause }),
      ),
      Effect.orElseSucceed(() => Option.none<SystemSleep>()),
    );
  if (Option.isNone(sleep))
    return yield* Effect.logDebug("pmset reported no system sleep setting; skipping the check");
  const { minutes, preventedBy } = sleep.value;
  if (minutes === 0) return yield* Effect.logDebug("System sleep is off");
  if (preventedBy.includes("caffeinate"))
    return yield* Effect.logInfo("System sleep is on, and caffeinate prevents it", {
      minutes,
      preventedBy,
    });
  yield* Effect.logWarning(
    "This Mac can sleep while runs are open. A sleep drops the SSH connections to workers and the gateway, and remote children must resume. Run `caffeinate -s` while runs are open, turn off sleep on AC power with `sudo pmset -c sleep 0`, or run the orchestrator on an always-on server: https://docs.usine.dev/guides/run-the-orchestrator-on-a-server/",
    { minutes, preventedBy },
  );
});
