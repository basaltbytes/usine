import type { InstanceDirectory } from "@usine/core/instance";
import { DateTime, Duration, Effect, Option } from "effect";
import { SERVER_HOST, packageVersion } from "./cli.ts";
import {
  SERVER_PACKAGE,
  compareVersions,
  installedInInstance,
  readManifest,
  realPathOrSelf,
  serverPin,
} from "./instance/manifest.ts";
import type { InstanceRecord } from "./instance/record.ts";
import { type ListedRun, listRuns } from "./instance/operator-api.ts";
import { type InstanceState, probeInstance } from "./instance/state.ts";
import { resolveVersion } from "./registry.ts";

/** What `usine status` prints, and whether a process holds the instance. */
export interface StatusReport {
  readonly running: boolean;
  readonly lines: ReadonlyArray<string>;
}

/** The Run states that count as open, in lifecycle order from the latest. */
const OPEN_STATES = ["Running", "Queued", "Waiting", "Pending"];

const ago = (since: DateTime.Utc, now: DateTime.Utc): string => {
  const seconds = Math.max(0, Math.floor(Duration.toSeconds(DateTime.distance(since, now))));
  return `${seconds === 0 ? "0s" : Duration.format(Duration.seconds(seconds))} ago`;
};

const field = (label: string, value: string) => `  ${label.padEnd(10)}${value}`;

/** Summarizes the open Runs by state, such as `2 running, 1 queued`. */
const openRuns = (runs: ReadonlyArray<ListedRun>): string => {
  const counts = OPEN_STATES.map(
    (state) => [state, runs.filter((run) => run.state === state).length] as const,
  ).filter(([, count]) => count > 0);
  return counts.length === 0
    ? "none open"
    : counts.map(([state, count]) => `${count} ${state.toLowerCase()}`).join(", ");
};

/** Returns the update line for an engine installed from a pin, or `None` for other engines. */
const updateLine = Effect.fn("Cli.statusUpdate")(function* (
  directory: InstanceDirectory,
  record: InstanceRecord,
  installed: boolean,
) {
  if (!installed) return Option.none<string>();
  const manifest = yield* readManifest(directory).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Could not read the instance's package.json", {
        path: error.path,
        reason: error.reason,
      }),
    ),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(Option.flatMap(manifest, serverPin))) return Option.none<string>();
  return Option.some(
    yield* resolveVersion(directory, SERVER_PACKAGE, "latest").pipe(
      Effect.map((latest) =>
        compareVersions(latest, record.version) > 0
          ? field("update", `@usine/server ${latest} is available. Run usine upgrade.`)
          : field("update", `none, ${record.version} is the latest release`),
      ),
      Effect.catchTag("PackageLookupError", (error) =>
        Effect.succeed(field("update", `unknown: ${error.reason}`)),
      ),
    ),
  );
});

const runningLines = Effect.fn("Cli.statusRunning")(function* (
  directory: InstanceDirectory,
  record: InstanceRecord,
) {
  const now = yield* DateTime.now;
  const runs = yield* listRuns(record.launch.port).pipe(
    Effect.map(openRuns),
    Effect.catchTag("OperatorApiError", (error) => Effect.succeed(`unavailable: ${error.reason}`)),
  );
  const installed = installedInInstance(
    yield* realPathOrSelf(directory),
    yield* realPathOrSelf(record.launch.script),
  );
  const lines = [
    record.stoppingSince === undefined
      ? `usine is running in ${directory}.`
      : `usine is stopping in ${directory}. Its drain started at ${DateTime.formatIso(record.stoppingSince)} (${ago(record.stoppingSince, now)}).`,
    field("pid", String(record.pid)),
    field("address", `http://${SERVER_HOST}:${record.launch.port}`),
    field(
      "engine",
      `${SERVER_PACKAGE} ${record.version}, ${installed ? "installed in the instance" : `from ${record.launch.script}`}`,
    ),
    field("started", `${DateTime.formatIso(record.startedAt)} (${ago(record.startedAt, now)})`),
    field("runs", runs),
  ];
  // The same entry point at another version means that the install changed after the start.
  if (process.argv[1] === record.launch.script) {
    const version = yield* packageVersion().pipe(Effect.option);
    if (Option.isSome(version) && version.value !== record.version) {
      lines.push(
        field("installed", `${SERVER_PACKAGE} ${version.value}. Run usine restart to run it.`),
      );
    }
  }
  lines.push(...Option.toArray(yield* updateLine(directory, record, installed)));
  return lines;
});

const reportOf = Effect.fn("Cli.statusReport")(function* (
  directory: InstanceDirectory,
  state: InstanceState,
) {
  switch (state._tag) {
    case "Running":
      return { running: true, lines: yield* runningLines(directory, state.record) };
    case "Unrecorded":
      return {
        running: true,
        lines: [
          Option.match(state.pid, {
            onNone: () =>
              `A process holds .usine/instance.lock in ${directory}, but .usine/instance.pid names no running process.`,
            onSome: (pid) =>
              `usine is running in ${directory} with pid ${pid}, without .usine/instance.json. It is a usine version that doesn't write one, or it is still starting.`,
          }),
        ],
      };
    case "Stopped":
      return {
        running: false,
        lines: [
          `usine is not running in ${directory}.`,
          ...Option.toArray(
            Option.map(state.stale, (pid) =>
              field(
                "stale",
                `pid ${pid} in .usine/ exited without removing its files. The next usine up replaces them.`,
              ),
            ),
          ),
        ],
      };
  }
});

/**
 * Reads whether `usine up` runs in the instance folder, with one request to its operator API and,
 * for an engine installed from a pin, one `npm view`.
 */
export const status = Effect.fn("Cli.status")(function* (directory: InstanceDirectory) {
  const report: StatusReport = yield* reportOf(directory, yield* probeInstance(directory));
  return report;
});
