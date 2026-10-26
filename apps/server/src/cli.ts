import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RunId } from "@usine/core/run";
import { Array as Arr, Console, Duration, Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ServeError } from "effect/unstable/http/HttpServerError";

export const DEFAULT_PORT = 7_331;
/** The address that the HTTP server listens on and the port check probes. */
export const SERVER_HOST = "127.0.0.1";
export const BROWSER_OPEN_TIMEOUT = "2 seconds";
const PORT_HOLDER_TIMEOUT = "2 seconds";

export const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }, { message: "Expected a TCP port" }),
).pipe(Schema.brand("ServerPort"));
export type Port = typeof Port.Type;

const PortFromString = Schema.NumberFromString.pipe(Schema.decodeTo(Port));

/** The minimum level of the lines `usine up` logs. */
export const UpLogLevel = Schema.Literals(["Trace", "Debug", "Info", "Warn", "Error"]);
export type UpLogLevel = typeof UpLogLevel.Type;

export const DEFAULT_LOG_LEVEL: UpLogLevel = "Info";

const LogLevelName = Schema.Literals(["trace", "debug", "info", "warn", "error"]);

const LOG_LEVEL_NAMES = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
} as const satisfies Record<typeof LogLevelName.Type, UpLogLevel>;

export const DEFAULT_LIFECYCLE_TIMEOUT_SECONDS = 120;

export const CLI_USAGE = `Usage:
  usine up [--port <port>] [--log-level <level>] [--allow-volatile-instance] [--detach]
  usine status
  usine stop [--timeout <seconds>] [--force]
  usine restart [--timeout <seconds>] [--force]
  usine upgrade [<version>] [--check] [--timeout <seconds>] [--force]
  usine backup <path>
  usine export-run <runId> [--output <path>]
  usine --help
  usine --version

Options:
  -p, --port <port>            Listen on this port (default: 7331)
  --log-level <level>          Log at this level and above: trace, debug, info, warn, or error (default: info)
  --allow-volatile-instance    Start even when the instance folder is in a temporary directory
  --detach                     Start in the background, with the output in .usine/usine.log
  --timeout <seconds>          Wait this long for the instance to stop, and again to start (default: ${DEFAULT_LIFECYCLE_TIMEOUT_SECONDS})
  --force                      Stop without waiting for running attempts; the next start reattaches them
  --check                      Print the running and the latest @usine/server version, and change nothing
  -o, --output <path>          Write the run evidence to this file (default: run-<encoded-runId>.json)
  -h, --help                   Print this help
  -v, --version                Print the installed @usine/server version

Environment:
  USINE_PORT                     Listen on this port if --port is not set
  USINE_LOG_LEVEL                Log at this level if --log-level is not set
  USINE_ALLOW_VOLATILE_INSTANCE  Set to 1 for the same effect as --allow-volatile-instance

Every command reads .env in the instance folder for the variables that the environment doesn't set.`;

export class CliUsageError extends Schema.TaggedError<CliUsageError>("@usine/server/CliUsageError")(
  "CliUsageError",
  { message: Schema.String },
) {}

export class CliVersionError extends Schema.TaggedError<CliVersionError>(
  "@usine/server/CliVersionError",
)("CliVersionError", { cause: Schema.Defect() }) {}

/** Another process is listening on the HTTP port. */
export class PortInUseError extends Schema.TaggedError<PortInUseError>(
  "@usine/server/PortInUseError",
)("PortInUseError", {
  port: Port,
  /** The PID of the listening process, or `None` if lsof can't find it. */
  holder: Schema.Option(Schema.Int),
}) {}

export class ServerStartError extends Schema.TaggedError<ServerStartError>(
  "@usine/server/ServerStartError",
)("ServerStartError", { port: Port, cause: Schema.Defect() }) {}

/** The instance folder is in a directory the OS may clear, which would delete the run history. */
export class VolatileInstanceDirectoryError extends Schema.TaggedError<VolatileInstanceDirectoryError>(
  "@usine/server/VolatileInstanceDirectoryError",
)("VolatileInstanceDirectoryError", {
  directory: Schema.String,
  root: Schema.String,
}) {}

export class BrowserOpenError extends Schema.TaggedError<BrowserOpenError>(
  "@usine/server/BrowserOpenError",
)("BrowserOpenError", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {}

export class HelpCommand extends Schema.TaggedClass<HelpCommand>("@usine/server/HelpCommand")(
  "HelpCommand",
  {},
) {}

export class VersionCommand extends Schema.TaggedClass<VersionCommand>(
  "@usine/server/VersionCommand",
)("VersionCommand", {}) {}

export class UpCommand extends Schema.TaggedClass<UpCommand>("@usine/server/UpCommand")(
  "UpCommand",
  {
    port: Port,
    logLevel: UpLogLevel,
    allowVolatileInstance: Schema.Boolean,
    detach: Schema.Boolean,
  },
) {}

/** Reports whether `usine up` runs in the current instance folder. */
export class StatusCommand extends Schema.TaggedClass<StatusCommand>("@usine/server/StatusCommand")(
  "StatusCommand",
  {},
) {}

/** How long a lifecycle command waits for each stop and start, and whether it ends the drain. */
export class LifecycleOptions extends Schema.Class<LifecycleOptions>(
  "@usine/server/LifecycleOptions",
)({
  timeout: Schema.Duration,
  /** Sends a second `SIGTERM`, which stops the instance without waiting for running Attempts. */
  force: Schema.Boolean,
}) {}

/** Stops the `usine up` of the current instance folder and waits for it to exit. */
export class StopCommand extends Schema.TaggedClass<StopCommand>("@usine/server/StopCommand")(
  "StopCommand",
  { options: LifecycleOptions },
) {}

/** Stops the `usine up` of the current instance folder and starts it again in the background. */
export class RestartCommand extends Schema.TaggedClass<RestartCommand>(
  "@usine/server/RestartCommand",
)("RestartCommand", { options: LifecycleOptions }) {}

/** Moves the instance's `@usine/server` pin to another published version and restarts it. */
export class UpgradeCommand extends Schema.TaggedClass<UpgradeCommand>(
  "@usine/server/UpgradeCommand",
)("UpgradeCommand", {
  /** A version or dist-tag; `latest` if absent. */
  version: Schema.Option(Schema.NonEmptyString),
  check: Schema.Boolean,
  options: LifecycleOptions,
}) {}

/** Exports one Run from the current instance into a new local JSON file. */
export class ExportRunCommand extends Schema.TaggedClass<ExportRunCommand>(
  "@usine/server/ExportRunCommand",
)("ExportRunCommand", {
  runId: RunId,
  output: Schema.Option(Schema.NonEmptyString),
}) {}

/** Copies the current instance's runtime store into a new SQLite file. */
export class BackupCommand extends Schema.TaggedClass<BackupCommand>("@usine/server/BackupCommand")(
  "BackupCommand",
  { output: Schema.NonEmptyString },
) {}

export interface CliEnvironment {
  readonly port: Option.Option<string>;
  readonly logLevel: Option.Option<string>;
  readonly allowVolatileInstance: Option.Option<string>;
}

export const CliCommand = Schema.Union([
  HelpCommand,
  VersionCommand,
  UpCommand,
  StatusCommand,
  StopCommand,
  RestartCommand,
  UpgradeCommand,
  ExportRunCommand,
  BackupCommand,
]);
export type CliCommand = typeof CliCommand.Type;

const usageError = (message = CLI_USAGE) => new CliUsageError({ message });

const decodePort = (
  source: "--port" | "USINE_PORT",
  value: string,
): Effect.Effect<Port, CliUsageError> =>
  Schema.decodeUnknownEffect(PortFromString)(value).pipe(
    Effect.mapError(() =>
      usageError(`${source} must be a whole number between 1 and 65535.\n\n${CLI_USAGE}`),
    ),
  );

/** Decodes a log level name, ignoring case. */
const decodeLogLevel = (
  source: "--log-level" | "USINE_LOG_LEVEL",
  value: string,
): Effect.Effect<UpLogLevel, CliUsageError> =>
  Schema.decodeUnknownEffect(LogLevelName)(value.toLowerCase()).pipe(
    Effect.map((name) => LOG_LEVEL_NAMES[name]),
    Effect.mapError(() =>
      usageError(`${source} must be trace, debug, info, warn, or error.\n\n${CLI_USAGE}`),
    ),
  );

const ALLOW_VOLATILE_FLAG = "--allow-volatile-instance";

const exportRunCommand = (args: ReadonlyArray<string>) => {
  const [runId, flag, output] = args;
  if (
    runId === undefined ||
    runId.startsWith("-") ||
    !(args.length === 1 || (args.length === 3 && (flag === "--output" || flag === "-o")))
  )
    return Effect.fail(usageError());
  return Schema.decodeUnknownEffect(ExportRunCommand)({
    _tag: "ExportRunCommand",
    runId,
    output: Option.fromUndefinedOr(output),
  }).pipe(Effect.mapError(() => usageError()));
};

const backupCommand = (args: ReadonlyArray<string>) => {
  const [output] = args;
  if (args.length !== 1 || output === undefined || output.startsWith("-"))
    return Effect.fail(usageError());
  return Schema.decodeUnknownEffect(BackupCommand)({ _tag: "BackupCommand", output }).pipe(
    Effect.mapError(() => usageError()),
  );
};

const upCommand = (
  args: ReadonlyArray<string>,
  environment: CliEnvironment,
): Effect.Effect<UpCommand, CliUsageError> =>
  Effect.gen(function* () {
    let port: Option.Option<string> = Option.none();
    let logLevel: Option.Option<string> = Option.none();
    let allowVolatileInstance = Option.exists(environment.allowVolatileInstance, (v) => v === "1");
    let detach = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--port" || arg === "-p") {
        const value = args[index + 1];
        if (value === undefined) return yield* usageError();
        port = Option.some(value);
        index += 1;
      } else if (arg?.startsWith("--port=")) {
        port = Option.some(arg.slice("--port=".length));
      } else if (arg === "--log-level") {
        const value = args[index + 1];
        if (value === undefined) return yield* usageError();
        logLevel = Option.some(value);
        index += 1;
      } else if (arg?.startsWith("--log-level=")) {
        logLevel = Option.some(arg.slice("--log-level=".length));
      } else if (arg === ALLOW_VOLATILE_FLAG) {
        allowVolatileInstance = true;
      } else if (arg === "--detach") {
        detach = true;
      } else {
        return yield* usageError();
      }
    }
    const resolvedPort = yield* Option.match(port, {
      onNone: () =>
        Option.match(environment.port, {
          onNone: () => Effect.succeed(Port.make(DEFAULT_PORT)),
          onSome: (value) => decodePort("USINE_PORT", value),
        }),
      onSome: (value) => decodePort("--port", value),
    });
    const resolvedLogLevel = yield* Option.match(logLevel, {
      onNone: () =>
        Option.match(environment.logLevel, {
          onNone: () => Effect.succeed(DEFAULT_LOG_LEVEL),
          onSome: (value) => decodeLogLevel("USINE_LOG_LEVEL", value),
        }),
      onSome: (value) => decodeLogLevel("--log-level", value),
    });
    return new UpCommand({
      port: resolvedPort,
      logLevel: resolvedLogLevel,
      allowVolatileInstance,
      detach,
    });
  });

const SecondsFromString = Schema.NumberFromString.pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThan(0))),
);

interface LifecycleArguments {
  readonly options: LifecycleOptions;
  readonly check: boolean;
  readonly operands: ReadonlyArray<string>;
}

/** Parses `--timeout`, `--force`, and, if `allowCheck`, `--check`, and collects the operands. */
const lifecycleArguments = (
  args: ReadonlyArray<string>,
  allowCheck: boolean,
): Effect.Effect<LifecycleArguments, CliUsageError> =>
  Effect.gen(function* () {
    let timeout: Option.Option<string> = Option.none();
    let force = false;
    let check = false;
    const operands: Array<string> = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (arg === "--timeout") {
        const value = args[index + 1];
        if (value === undefined) return yield* usageError();
        timeout = Option.some(value);
        index += 1;
      } else if (arg.startsWith("--timeout=")) {
        timeout = Option.some(arg.slice("--timeout=".length));
      } else if (arg === "--force") {
        force = true;
      } else if (arg === "--check" && allowCheck) {
        check = true;
      } else if (arg !== "" && !arg.startsWith("-")) {
        operands.push(arg);
      } else {
        return yield* usageError();
      }
    }
    const seconds = yield* Option.match(timeout, {
      onNone: () => Effect.succeed(DEFAULT_LIFECYCLE_TIMEOUT_SECONDS),
      onSome: (value) =>
        Schema.decodeUnknownEffect(SecondsFromString)(value).pipe(
          Effect.mapError(() =>
            usageError(`--timeout must be a whole number of seconds above 0.\n\n${CLI_USAGE}`),
          ),
        ),
    });
    return {
      options: new LifecycleOptions({ timeout: Duration.seconds(seconds), force }),
      check,
      operands,
    };
  });

const stopOrRestartCommand = (command: "stop" | "restart", args: ReadonlyArray<string>) =>
  Effect.flatMap(lifecycleArguments(args, false), ({ options, operands }) => {
    if (operands.length > 0) return Effect.fail(usageError());
    return Effect.succeed(
      command === "stop" ? new StopCommand({ options }) : new RestartCommand({ options }),
    );
  });

const upgradeCommand = (args: ReadonlyArray<string>) =>
  Effect.flatMap(lifecycleArguments(args, true), ({ options, check, operands }) => {
    const [version, ...rest] = operands;
    if (rest.length > 0) return Effect.fail(usageError());
    return Effect.succeed(
      new UpgradeCommand({ version: Option.fromUndefinedOr(version), check, options }),
    );
  });

const SUBCOMMANDS: ReadonlySet<string> = new Set([
  "up",
  "status",
  "stop",
  "restart",
  "upgrade",
  "backup",
  "export-run",
]);

/** Parses process arguments and the environment into one validated CLI command. */
export const parseCli = Effect.fn("Cli.parse")((
  args: ReadonlyArray<string>,
  environment: CliEnvironment,
): Effect.Effect<CliCommand, CliUsageError> => {
  const [command = "", ...rest] = args;
  if (
    (args.length === 1 && (command === "--help" || command === "-h")) ||
    (args.length === 2 && SUBCOMMANDS.has(command) && (rest[0] === "--help" || rest[0] === "-h"))
  ) {
    return Effect.succeed(new HelpCommand());
  }
  if (args.length === 1 && (command === "--version" || command === "-v")) {
    return Effect.succeed(new VersionCommand());
  }
  switch (command) {
    case "backup":
      return backupCommand(rest);
    case "export-run":
      return exportRunCommand(rest);
    case "up":
      return upCommand(rest, environment);
    case "status":
      return rest.length === 0 ? Effect.succeed(new StatusCommand()) : Effect.fail(usageError());
    case "stop":
    case "restart":
      return stopOrRestartCommand(command, rest);
    case "upgrade":
      return upgradeCommand(rest);
    default:
      return Effect.fail(usageError());
  }
});

/**
 * Returns the directories the OS may clear: `os.tmpdir()`, `$TMPDIR`, and common temp locations.
 */
export const volatileRoots = (environmentTmpdir: Option.Option<string>): ReadonlyArray<string> =>
  [
    ...new Set([
      tmpdir(),
      ...Option.toArray(environmentTmpdir),
      "/tmp",
      "/private/tmp",
      "/var/folders",
    ]),
  ]
    .filter((root) => root.length > 0)
    .map((root) => resolve(root));

const isUnder = (directory: string, root: string): boolean =>
  directory === root || directory.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Returns the volatile root that contains `directory`, if any, without resolving symlinks. */
export const volatileRoot = (
  directory: string,
  roots: ReadonlyArray<string>,
): Option.Option<string> => {
  const resolved = resolve(directory);
  return Option.fromNullishOr(roots.find((root) => isUnder(resolved, root)));
};

const PackageMetadataFromJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.NonEmptyString }),
);

export const packageVersion = Effect.fn("Cli.packageVersion")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const source = yield* fileSystem
    .readFileString(packagePath)
    .pipe(Effect.mapError((cause) => new CliVersionError({ cause })));
  const metadata = yield* Schema.decodeUnknownEffect(PackageMetadataFromJson)(source).pipe(
    Effect.mapError((cause) => new CliVersionError({ cause })),
  );
  return metadata.version;
});

const AddressInUse = Schema.Struct({ code: Schema.Literal("EADDRINUSE") });

/** Returns `PortInUseError` for `EADDRINUSE`, otherwise `ServerStartError`. */
export const serverStartError = (port: Port, error: ServeError) =>
  Schema.is(AddressInUse)(error.cause)
    ? new PortInUseError({ port, holder: Option.none() })
    : new ServerStartError({ port, cause: error.cause });

const ProcessIdFromString = Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int));

/**
 * Returns the PID listening on `port` from lsof, or `None` if lsof is missing or can't see the
 * process.
 */
const portHolder = Effect.fn("Cli.portHolder")(function* (port: Port) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lines = yield* spawner
    .lines(
      ChildProcess.make("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeout(PORT_HOLDER_TIMEOUT),
      Effect.tapError((cause) =>
        Effect.logDebug("Could not look up the process listening on the port", { port, cause }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
  return Arr.findFirst(lines, (line) =>
    Schema.decodeUnknownOption(ProcessIdFromString)(line.trim()),
  );
});

/** Fails with `PortInUseError`, with the listening PID if found. */
export const portInUse = Effect.fn("Cli.portInUse")(function* (port: Port) {
  const holder = yield* portHolder(port);
  yield* Effect.logWarning("Another process listens on the HTTP port", {
    port,
    holder: Option.getOrUndefined(holder),
  });
  return yield* new PortInUseError({ port, holder });
});

const portTaken = (port: Port) =>
  Effect.callback<boolean, ServerStartError>((resume) => {
    const server = createServer();
    server.once("error", (cause) =>
      resume(
        Schema.is(AddressInUse)(cause)
          ? Effect.succeed(true)
          : Effect.fail(new ServerStartError({ port, cause })),
      ),
    );
    server.listen({ host: SERVER_HOST, port }, () =>
      server.close(() => resume(Effect.succeed(false))),
    );
    return Effect.sync(() => server.close());
  });

/**
 * Fails with `PortInUseError` if another process is listening on `port`. Call it before `usine up`
 * builds its runtime.
 */
export const refuseTakenPort = Effect.fn("Cli.refuseTakenPort")(function* (port: Port) {
  if (yield* portTaken(port)) return yield* portInUse(port);
});

const browserCommand = (url: string) => {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
};

/** Opens the setup page in a browser. Call it only after the HTTP server has bound. */
export const openBrowser = Effect.fn("Cli.openBrowser")(function* (
  url: string,
  timeout: Duration.Input = BROWSER_OPEN_TIMEOUT,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { command, args } = browserCommand(url);
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(command, args, {
        detached: false,
        forceKillAfter: "1 second",
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(Effect.timeout(timeout))
    .pipe(Effect.mapError((cause) => new BrowserOpenError({ command, cause })));
  if (Number(exitCode) !== 0) {
    return yield* new BrowserOpenError({
      command,
      cause: new Error(`${command} exited with code ${String(exitCode)}`),
    });
  }
  yield* Console.log(`Opened ${url}`);
});
