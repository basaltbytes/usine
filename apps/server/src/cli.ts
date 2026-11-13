import { LoginProvider } from "@usine/gateway/credentials";
import type { HttpServerError } from "effect/http";
import { UiOrigin } from "@usine/config/factory";
import { UpgradeChannel } from "@usine/core/upgrade";
import { ConfigCommand, parseConfigCommand } from "./configuration/command.ts";
import { tmpdir } from "node:os";
// volatileRoots and volatileRoot synchronously normalize paths for CLI validation.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve, sep } from "node:path";
import { RunId } from "@usine/core/run";
import {
  type Brand,
  Array as Arr,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const DEFAULT_PORT = 7_331;
/** The address that the HTTP server listens on and the port check probes. */
export const SERVER_HOST = "127.0.0.1";
export const BROWSER_OPEN_TIMEOUT = "2 seconds";
const PORT_HOLDER_TIMEOUT = "2 seconds";

export const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }, { message: "Expected a TCP port" }),
).pipe(Schema.brand("ServerPort"));
export type Port = typeof Port.Type;

const PortFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(Port));

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
  usine config export <folder>
  usine config import <folder> [--message <text>]
  usine config edit <kind> <name>
  usine config log [<kind> <name>]
  usine up [--port <port>] [--origin <url>] [--log-level <level>] [--allow-volatile-instance] [--detach]
  usine status
  usine sign-in [<instance-url>]
  usine sign-in-link
  usine mcp [--origin <url>]
  usine stop [--timeout <seconds>] [--force]
  usine restart [--timeout <seconds>] [--force]
  usine upgrade [<version> | --channel <latest|next>] [--check] [--timeout <seconds>] [--force]
  usine backup <path>
  usine export-run <runId> [--output <path>]
  usine --help
  usine --version

Options:
  -p, --port <port>            Listen on this port (default: 7331)
  --origin <url>               up: also accept the UI's pages at this origin, such as the URL of tailscale serve
                               mcp: serve the tools of the instance at this URL, with USINE_TOKEN
  --log-level <level>          Log at this level and above: trace, debug, info, warn, or error (default: info)
  --allow-volatile-instance    Start even when the instance folder is in a temporary directory
  --detach                     Start in the background, with the output in .usine/usine.log
  --timeout <seconds>          Wait this long for the instance to stop, and for the new one to listen or log a line (default: ${DEFAULT_LIFECYCLE_TIMEOUT_SECONDS})
  --force                      Stop without waiting for running attempts; the next start reattaches them
  --check                      Print the running and the latest @usine/server version, and change nothing
  -o, --output <path>          Write the run evidence to this file (default: run-<encoded-runId>.json)
  -h, --help                   Print this help
  -v, --version                Print the installed @usine/server version

  login <claude|chatgpt>       Connect a provider; --api-key reads an API key
  logout <claude|chatgpt>      Disconnect a provider; --target selects a gateway

Environment:
  USINE_PORT                     Listen on this port if --port is not set
  USINE_ORIGIN                   Also accept the UI's pages at this origin if --origin is not set
  USINE_LOG_LEVEL                Log at this level if --log-level is not set
  USINE_ALLOW_VOLATILE_INSTANCE  Set to 1 for the same effect as --allow-volatile-instance
  USINE_TOKEN                    The instance token that usine mcp --origin sends

Every command reads .env in the instance folder for the variables that the environment doesn't set.`;

export class CliUsageError extends Schema.TaggedError<
  CliUsageError,
  Brand.Brand<"@usine/server/cli/CliUsageError">
>("@usine/server/CliUsageError")("CliUsageError", { message: Schema.String }) {}

export class CliVersionError extends Schema.TaggedError<
  CliVersionError,
  Brand.Brand<"@usine/server/cli/CliVersionError">
>("@usine/server/CliVersionError")("CliVersionError", { cause: Schema.Defect() }) {}

/** Another process is listening on the HTTP port. */
export class PortInUseError extends Schema.TaggedError<
  PortInUseError,
  Brand.Brand<"@usine/server/cli/PortInUseError">
>("@usine/server/PortInUseError")("PortInUseError", {
  port: Port,
  /** The PID of the listening process, or `None` if lsof can't find it. */
  holder: Schema.Option(Schema.Int),
}) {}

export class ServerStartError extends Schema.TaggedError<
  ServerStartError,
  Brand.Brand<"@usine/server/cli/ServerStartError">
>("@usine/server/ServerStartError")("ServerStartError", { port: Port, cause: Schema.Defect() }) {}

/** The instance folder is in a directory the OS may clear, which would delete the run history. */
export class VolatileInstanceDirectoryError extends Schema.TaggedError<
  VolatileInstanceDirectoryError,
  Brand.Brand<"@usine/server/cli/VolatileInstanceDirectoryError">
>("@usine/server/VolatileInstanceDirectoryError")("VolatileInstanceDirectoryError", {
  directory: Schema.String,
  root: Schema.String,
}) {}

export class BrowserOpenError extends Schema.TaggedError<
  BrowserOpenError,
  Brand.Brand<"@usine/server/cli/BrowserOpenError">
>("@usine/server/BrowserOpenError")("BrowserOpenError", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {}

export class HelpCommand extends Schema.TaggedClass<
  HelpCommand,
  Brand.Brand<"@usine/server/cli/HelpCommand">
>("@usine/server/HelpCommand")("HelpCommand", {}) {}

export class VersionCommand extends Schema.TaggedClass<
  VersionCommand,
  Brand.Brand<"@usine/server/cli/VersionCommand">
>("@usine/server/VersionCommand")("VersionCommand", {}) {}

export class UpCommand extends Schema.TaggedClass<
  UpCommand,
  Brand.Brand<"@usine/server/cli/UpCommand">
>("@usine/server/UpCommand")("UpCommand", {
  port: Port,
  /** The origin of the UI's pages besides the loopback ones, which the operator API accepts. */
  origin: Schema.Option(UiOrigin),
  logLevel: UpLogLevel,
  allowVolatileInstance: Schema.Boolean,
  detach: Schema.Boolean,
}) {}

/** Reports whether `usine up` runs in the current instance folder. */
export class StatusCommand extends Schema.TaggedClass<
  StatusCommand,
  Brand.Brand<"@usine/server/cli/StatusCommand">
>("@usine/server/StatusCommand")("StatusCommand", {}) {}

/** How long a lifecycle command waits for each stop and start, and whether it ends the drain. */
export class LifecycleOptions extends Schema.Class<
  LifecycleOptions,
  Brand.Brand<"@usine/server/cli/LifecycleOptions">
>("@usine/server/LifecycleOptions")({
  timeout: Schema.Duration,
  /** Sends a second `SIGTERM`, which stops the instance without waiting for running Attempts. */
  force: Schema.Boolean,
}) {}

/** Stops the `usine up` of the current instance folder and waits for it to exit. */
export class StopCommand extends Schema.TaggedClass<
  StopCommand,
  Brand.Brand<"@usine/server/cli/StopCommand">
>("@usine/server/StopCommand")("StopCommand", { options: LifecycleOptions }) {}

/** Stops the `usine up` of the current instance folder and starts it again in the background. */
export class RestartCommand extends Schema.TaggedClass<
  RestartCommand,
  Brand.Brand<"@usine/server/cli/RestartCommand">
>("@usine/server/RestartCommand")("RestartCommand", { options: LifecycleOptions }) {}

/** Moves the instance's `@usine/server` pin to another published version and restarts it. */
export class UpgradeCommand extends Schema.TaggedClass<
  UpgradeCommand,
  Brand.Brand<"@usine/server/cli/UpgradeCommand">
>("@usine/server/UpgradeCommand")("UpgradeCommand", {
  /** A version or dist-tag; `latest` if absent. */
  version: Schema.Option(Schema.NonEmptyString),
  check: Schema.Boolean,
  options: LifecycleOptions,
}) {}

/** Exports one Run from the current instance into a new local JSON file. */
export class ExportRunCommand extends Schema.TaggedClass<
  ExportRunCommand,
  Brand.Brand<"@usine/server/cli/ExportRunCommand">
>("@usine/server/ExportRunCommand")("ExportRunCommand", {
  runId: RunId,
  output: Schema.Option(Schema.NonEmptyString),
}) {}

/** Copies the current instance's runtime store into a new SQLite file. */
export class BackupCommand extends Schema.TaggedClass<
  BackupCommand,
  Brand.Brand<"@usine/server/cli/BackupCommand">
>("@usine/server/BackupCommand")("BackupCommand", { output: Schema.NonEmptyString }) {}

export class SignInCommand extends Schema.TaggedClass<
  SignInCommand,
  Brand.Brand<"@usine/server/cli/SignInCommand">
>()("SignInCommand", { action: Schema.Literals(["device", "link"]), origin: UiOrigin }) {}

/** Serves the operator API as MCP tools over standard input and output. */
export class McpCommand extends Schema.TaggedClass<
  McpCommand,
  Brand.Brand<"@usine/server/cli/McpCommand">
>()("McpCommand", {
  /** The instance to serve; `None` serves the running instance of the current folder. */
  origin: Schema.Option(UiOrigin),
}) {}

export class ProviderCommand extends Schema.TaggedClass<
  ProviderCommand,
  { readonly brand: unique symbol }
>()("ProviderCommand", {
  action: Schema.Literals(["login", "logout"]),
  provider: LoginProvider,
  mode: Schema.Literals(["subscription", "api-key"]),
  target: Schema.Option(Schema.NonEmptyString),
}) {}

export interface CliEnvironment {
  readonly port: Option.Option<string>;
  readonly origin: Option.Option<string>;
  readonly logLevel: Option.Option<string>;
  readonly allowVolatileInstance: Option.Option<string>;
}

export const CliCommand = Schema.Union([
  ConfigCommand,
  SignInCommand,
  McpCommand,
  ProviderCommand,
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

const usageError = (message = CLI_USAGE) => CliUsageError.make({ message });

const decodePort = (
  source: "--port" | "USINE_PORT",
  value: string,
): Effect.Effect<Port, CliUsageError> =>
  Schema.decodeEffect(PortFromString)(value).pipe(
    Effect.mapError(() =>
      usageError(`${source} must be a whole number between 1 and 65535.\n\n${CLI_USAGE}`),
    ),
  );

/** Returns the origin of a URL without a path, query, or fragment, else `value` itself. */
const originOf = (value: string): string => {
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  return url.href === `${url.origin}/` ? url.origin : value;
};

/** Decodes the URL of the UI's pages, such as `https://orchestrator.example.ts.net/`. */
const decodeUiOrigin = (
  source: "--origin" | "USINE_ORIGIN",
  value: string,
): Effect.Effect<UiOrigin, CliUsageError> =>
  Schema.decodeEffect(UiOrigin)(originOf(value)).pipe(
    Effect.mapError(() =>
      usageError(
        `${source} must be the http or https URL of the UI without a path, such as https://orchestrator.example.ts.net.\n\n${CLI_USAGE}`,
      ),
    ),
  );

/** Decodes a log level name, ignoring case. */
const decodeLogLevel = (
  source: "--log-level" | "USINE_LOG_LEVEL",
  value: string,
): Effect.Effect<UpLogLevel, CliUsageError> =>
  Schema.decodeUnknownEffect(LogLevelName)(value.toLowerCase()).pipe(
    Effect.mapBoth({
      onSuccess: (name) => LOG_LEVEL_NAMES[name],
      onFailure: () =>
        usageError(`${source} must be trace, debug, info, warn, or error.\n\n${CLI_USAGE}`),
    }),
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
  return Schema.decodeEffect(ExportRunCommand)({
    _tag: "ExportRunCommand",
    runId,
    output: Option.fromUndefinedOr(output),
  }).pipe(Effect.mapError(() => usageError()));
};

const backupCommand = (args: ReadonlyArray<string>) => {
  const [output] = args;
  if (args.length !== 1 || output === undefined || output.startsWith("-"))
    return Effect.fail(usageError());
  return Schema.decodeEffect(BackupCommand)({ _tag: "BackupCommand", output }).pipe(
    Effect.mapError(() => usageError()),
  );
};

const upCommand = (
  args: ReadonlyArray<string>,
  environment: CliEnvironment,
): Effect.Effect<UpCommand, CliUsageError> =>
  Effect.gen(function* () {
    let port: Option.Option<string> = Option.none();
    let origin: Option.Option<string> = Option.none();
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
      } else if (arg?.startsWith("--port=") === true) {
        port = Option.some(arg.slice("--port=".length));
      } else if (arg === "--origin") {
        const value = args[index + 1];
        if (value === undefined) return yield* usageError();
        origin = Option.some(value);
        index += 1;
      } else if (arg?.startsWith("--origin=") === true) {
        origin = Option.some(arg.slice("--origin=".length));
      } else if (arg === "--log-level") {
        const value = args[index + 1];
        if (value === undefined) return yield* usageError();
        logLevel = Option.some(value);
        index += 1;
      } else if (arg?.startsWith("--log-level=") === true) {
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
    const resolvedOrigin = yield* Option.match(origin, {
      onNone: () =>
        Option.match(environment.origin, {
          onNone: () => Effect.succeedNone,
          onSome: (value) => Effect.asSome(decodeUiOrigin("USINE_ORIGIN", value)),
        }),
      onSome: (value) => Effect.asSome(decodeUiOrigin("--origin", value)),
    });
    const resolvedLogLevel = yield* Option.match(logLevel, {
      onNone: () =>
        Option.match(environment.logLevel, {
          onNone: () => Effect.succeed(DEFAULT_LOG_LEVEL),
          onSome: (value) => decodeLogLevel("USINE_LOG_LEVEL", value),
        }),
      onSome: (value) => decodeLogLevel("--log-level", value),
    });
    return UpCommand.make({
      port: resolvedPort,
      origin: resolvedOrigin,
      logLevel: resolvedLogLevel,
      allowVolatileInstance,
      detach,
    });
  });

/** Returns the settings of a `usine up` without flags: those of the environment, or the defaults. */
export const environmentUp = (environment: CliEnvironment) => upCommand([], environment);

const SecondsFromString = Schema.FiniteFromString.pipe(
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
      } else if (arg === "--channel" && allowCheck) {
        const channel = Schema.decodeUnknownOption(UpgradeChannel)(args[index + 1]);
        if (Option.isNone(channel)) return yield* usageError();
        operands.push(channel.value);
        index += 1;
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
        Schema.decodeEffect(SecondsFromString)(value).pipe(
          Effect.mapError(() =>
            usageError(`--timeout must be a whole number of seconds above 0.\n\n${CLI_USAGE}`),
          ),
        ),
    });
    return {
      options: LifecycleOptions.make({ timeout: Duration.seconds(seconds), force }),
      check,
      operands,
    };
  });

const stopOrRestartCommand = (command: "stop" | "restart", args: ReadonlyArray<string>) =>
  Effect.flatMap(lifecycleArguments(args, false), ({ options, operands }) => {
    if (operands.length > 0) return Effect.fail(usageError());
    return Effect.succeed(
      command === "stop" ? StopCommand.make({ options }) : RestartCommand.make({ options }),
    );
  });

const upgradeCommand = (args: ReadonlyArray<string>) =>
  Effect.flatMap(lifecycleArguments(args, true), ({ options, check, operands }) => {
    const [version, ...rest] = operands;
    if (rest.length > 0) return Effect.fail(usageError());
    return Effect.succeed(
      UpgradeCommand.make({ version: Option.fromUndefinedOr(version), check, options }),
    );
  });

const mcpCommandOf = (args: ReadonlyArray<string>) => {
  const [flag, value, ...rest] = args;
  if (args.length === 0) return Effect.succeed(McpCommand.make({ origin: Option.none() }));
  const origin =
    flag === "--origin" && rest.length === 0
      ? value
      : flag?.startsWith("--origin=") === true && args.length === 1
        ? flag.slice("--origin=".length)
        : undefined;
  if (origin === undefined) return Effect.fail(usageError());
  return Effect.map(decodeUiOrigin("--origin", origin), (decoded) =>
    McpCommand.make({ origin: Option.some(decoded) }),
  );
};

const SUBCOMMANDS: ReadonlySet<string> = new Set([
  "config",
  "mcp",
  "login",
  "logout",
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
    return Effect.succeed(HelpCommand.make());
  }
  if (args.length === 1 && (command === "--version" || command === "-v")) {
    return Effect.succeed(VersionCommand.make());
  }
  switch (command) {
    case "login":
    case "logout": {
      const [provider, ...flags] = rest;
      if (!Schema.is(LoginProvider)(provider))
        return Effect.fail(usageError("Choose claude or chatgpt."));
      let mode: "subscription" | "api-key" = "subscription";
      let target = Option.none<string>();
      while (flags.length > 0) {
        const flag = flags.shift();
        if (flag === "--api-key" && command === "login") mode = "api-key";
        else if (
          flag === "--target" &&
          flags[0] !== undefined &&
          flags[0].length > 0 &&
          !flags[0].startsWith("--")
        )
          target = Option.some(flags.shift() ?? "");
        else return Effect.fail(usageError());
      }
      return Effect.succeed(ProviderCommand.make({ action: command, provider, mode, target }));
    }
    case "sign-in":
    case "sign-in-link":
      if (rest.length > (command === "sign-in" ? 1 : 0)) return Effect.fail(usageError());
      return Effect.gen(function* () {
        const options = yield* environmentUp(environment);
        const origin = yield* decodeUiOrigin(
          "--origin",
          rest[0] ?? Option.getOrElse(options.origin, () => `http://127.0.0.1:${options.port}`),
        );
        return SignInCommand.make({ action: command === "sign-in" ? "device" : "link", origin });
      });
    case "mcp":
      return mcpCommandOf(rest);
    case "config":
      return parseConfigCommand(rest).pipe(Effect.mapError(({ message }) => usageError(message)));
    case "backup":
      return backupCommand(rest);
    case "export-run":
      return exportRunCommand(rest);
    case "up":
      return upCommand(rest, environment);
    case "status":
      return rest.length === 0 ? Effect.succeed(StatusCommand.make()) : Effect.fail(usageError());
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
  const path = yield* Path.Path;
  const packagePath = yield* path
    .fromFileUrl(new URL("../package.json", import.meta.url))
    .pipe(Effect.mapError((cause) => CliVersionError.make({ cause })));
  const source = yield* fileSystem
    .readFileString(packagePath)
    .pipe(Effect.mapError((cause) => CliVersionError.make({ cause })));
  const metadata = yield* Schema.decodeEffect(PackageMetadataFromJson)(source).pipe(
    Effect.mapError((cause) => CliVersionError.make({ cause })),
  );
  return metadata.version;
});

const AddressInUse = Schema.Struct({ code: Schema.Literal("EADDRINUSE") });

/** Returns `PortInUseError` for `EADDRINUSE`, otherwise `ServerStartError`. */
export const serverStartError = (port: Port, error: HttpServerError.ServeError) =>
  Schema.is(AddressInUse)(error.cause)
    ? PortInUseError.make({ port, holder: Option.none() })
    : ServerStartError.make({ port, cause: error.cause });

const ProcessIdFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int));

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
  return Arr.findFirst(lines, (line) => Schema.decodeOption(ProcessIdFromString)(line.trim()));
});

/** Fails with `PortInUseError`, with the listening PID if found. */
export const portInUse = Effect.fn("Cli.portInUse")(function* (port: Port) {
  const holder = yield* portHolder(port);
  yield* Effect.logWarning("Another process listens on the HTTP port", {
    port,
    holder: Option.getOrUndefined(holder),
  });
  return yield* PortInUseError.make({ port, holder });
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
    .pipe(
      Effect.timeout(timeout),
      Effect.mapError((cause) => BrowserOpenError.make({ command, cause })),
    );
  if (Number(exitCode) !== 0) {
    return yield* BrowserOpenError.make({
      command,
      cause: new Error(`${command} exited with code ${String(exitCode)}`),
    });
  }
  yield* Console.log(`Opened ${url}`);
});
