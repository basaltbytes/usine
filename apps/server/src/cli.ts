import { fileURLToPath } from "node:url";
import { Console, Duration, Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ServeError } from "effect/unstable/http/HttpServerError";

export const DEFAULT_PORT = 7_331;
export const BROWSER_OPEN_TIMEOUT = "2 seconds";

export const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }, { message: "Expected a TCP port" }),
).pipe(Schema.brand("ServerPort"));
export type Port = typeof Port.Type;

const PortFromString = Schema.NumberFromString.pipe(Schema.decodeTo(Port));

export const CLI_USAGE = `Usage:
  usine up [--port <port>]
  usine --help
  usine --version

Options:
  -p, --port <port>  Listen on this port (default: 7331)
  -h, --help         Print this usage
  -v, --version      Print the pinned @usine/server version

Environment:
  USINE_PORT         Listen on this port when --port is absent`;

export class CliUsageError extends Schema.TaggedError<CliUsageError>("@usine/server/CliUsageError")(
  "CliUsageError",
  { message: Schema.String },
) {}

export class CliVersionError extends Schema.TaggedError<CliVersionError>(
  "@usine/server/CliVersionError",
)("CliVersionError", { cause: Schema.Defect() }) {}

export class PortInUseError extends Schema.TaggedError<PortInUseError>(
  "@usine/server/PortInUseError",
)("PortInUseError", { port: Port }) {}

export class ServerStartError extends Schema.TaggedError<ServerStartError>(
  "@usine/server/ServerStartError",
)("ServerStartError", { port: Port, cause: Schema.Defect() }) {}

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
  { port: Port },
) {}

export const CliCommand = Schema.Union([HelpCommand, VersionCommand, UpCommand]);
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

const upPort = (
  args: ReadonlyArray<string>,
  environmentPort: Option.Option<string>,
): Effect.Effect<Port, CliUsageError> => {
  if (args.length === 0) {
    return Option.match(environmentPort, {
      onNone: () => Effect.succeed(Port.make(DEFAULT_PORT)),
      onSome: (value) => decodePort("USINE_PORT", value),
    });
  }
  if (args.length === 2 && (args[0] === "--port" || args[0] === "-p")) {
    const value = args[1];
    return value === undefined ? Effect.fail(usageError()) : decodePort("--port", value);
  }
  if (args.length === 1 && args[0]?.startsWith("--port=")) {
    return decodePort("--port", args[0].slice("--port=".length));
  }
  return Effect.fail(usageError());
};

/** Parse process arguments and environment into one validated CLI command. */
export const parseCli = Effect.fn("Cli.parse")((
  args: ReadonlyArray<string>,
  environmentPort: Option.Option<string>,
): Effect.Effect<CliCommand, CliUsageError> => {
  if (
    (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) ||
    (args.length === 2 && args[0] === "up" && (args[1] === "--help" || args[1] === "-h"))
  ) {
    return Effect.succeed(new HelpCommand());
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return Effect.succeed(new VersionCommand());
  }
  if (args[0] !== "up") return Effect.fail(usageError());
  return upPort(args.slice(1), environmentPort).pipe(Effect.map((port) => new UpCommand({ port })));
});

const PackageMetadataFromJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.NonEmptyString }),
);

/** Read the package version npm pinned for this installed server. */
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

/** Translate Effect's low-level bind failure into the CLI's startup vocabulary. */
export const serverStartError = (port: Port, error: ServeError) =>
  Schema.is(AddressInUse)(error.cause)
    ? new PortInUseError({ port })
    : new ServerStartError({ port, cause: error.cause });

const browserCommand = (url: string) => {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
};

/** Open the setup page after the HTTP server has bound successfully. */
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
