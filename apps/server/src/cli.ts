import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RunId } from "@usine/core/run";
import { Array as Arr, Console, Duration, Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ServeError } from "effect/unstable/http/HttpServerError";

export const DEFAULT_PORT = 7_331;
/** The address the HTTP server listens on; the port check probes the same one. */
export const SERVER_HOST = "127.0.0.1";
export const BROWSER_OPEN_TIMEOUT = "2 seconds";
const PORT_HOLDER_TIMEOUT = "2 seconds";

export const Port = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }, { message: "Expected a TCP port" }),
).pipe(Schema.brand("ServerPort"));
export type Port = typeof Port.Type;

const PortFromString = Schema.NumberFromString.pipe(Schema.decodeTo(Port));

export const CLI_USAGE = `Usage:
  usine up [--port <port>] [--allow-volatile-instance]
  usine backup <path>
  usine export-run <runId> [--output <path>]
  usine --help
  usine --version

Options:
  -p, --port <port>            Listen on this port (default: 7331)
  --allow-volatile-instance    Start even when the instance folder sits under a temp path
  -o, --output <path>          Write Run evidence here (default: run-<encoded-runId>.json)
  -h, --help                   Print this usage
  -v, --version                Print the pinned @usine/server version

Environment:
  USINE_PORT                     Listen on this port when --port is absent
  USINE_ALLOW_VOLATILE_INSTANCE  Same as --allow-volatile-instance when set to 1`;

export class CliUsageError extends Schema.TaggedError<CliUsageError>("@usine/server/CliUsageError")(
  "CliUsageError",
  { message: Schema.String },
) {}

export class CliVersionError extends Schema.TaggedError<CliVersionError>(
  "@usine/server/CliVersionError",
)("CliVersionError", { cause: Schema.Defect() }) {}

/** Another process listens on the HTTP port. */
export class PortInUseError extends Schema.TaggedError<PortInUseError>(
  "@usine/server/PortInUseError",
)("PortInUseError", {
  port: Port,
  /** The listening process's id, when lsof could tell. */
  holder: Schema.Option(Schema.Int),
}) {}

export class ServerStartError extends Schema.TaggedError<ServerStartError>(
  "@usine/server/ServerStartError",
)("ServerStartError", { port: Port, cause: Schema.Defect() }) {}

/** Raised when the instance folder sits under a path the OS may clear, since its runtime store is the only copy of run history. */
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
  { port: Port, allowVolatileInstance: Schema.Boolean },
) {}

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
  readonly allowVolatileInstance: Option.Option<string>;
}

export const CliCommand = Schema.Union([
  HelpCommand,
  VersionCommand,
  UpCommand,
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
    let allowVolatileInstance = Option.exists(environment.allowVolatileInstance, (v) => v === "1");
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--port" || arg === "-p") {
        const value = args[index + 1];
        if (value === undefined) return yield* usageError();
        port = Option.some(value);
        index += 1;
      } else if (arg?.startsWith("--port=")) {
        port = Option.some(arg.slice("--port=".length));
      } else if (arg === ALLOW_VOLATILE_FLAG) {
        allowVolatileInstance = true;
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
    return new UpCommand({ port: resolvedPort, allowVolatileInstance });
  });

/** Parses process arguments and the environment into one validated CLI command. */
export const parseCli = Effect.fn("Cli.parse")((
  args: ReadonlyArray<string>,
  environment: CliEnvironment,
): Effect.Effect<CliCommand, CliUsageError> => {
  if (
    (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) ||
    (args.length === 2 &&
      (args[0] === "up" || args[0] === "export-run" || args[0] === "backup") &&
      (args[1] === "--help" || args[1] === "-h"))
  ) {
    return Effect.succeed(new HelpCommand());
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return Effect.succeed(new VersionCommand());
  }
  if (args[0] === "backup") return backupCommand(args.slice(1));
  if (args[0] === "export-run") return exportRunCommand(args.slice(1));
  if (args[0] !== "up") return Effect.fail(usageError());
  return upCommand(args.slice(1), environment);
});

/** Directories the OS may clear: `os.tmpdir()`, `$TMPDIR`, and the usual temp locations. */
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

/** Returns the volatile root the directory sits under, if any. Paths are compared as given, with symlinks unresolved. */
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

/** Reads the version of this installed server from its package.json. */
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

/** Maps a bind failure to the CLI's startup error, so an address already in use is reported as such. */
export const serverStartError = (port: Port, error: ServeError) =>
  Schema.is(AddressInUse)(error.cause)
    ? new PortInUseError({ port, holder: Option.none() })
    : new ServerStartError({ port, cause: error.cause });

const ProcessIdFromString = Schema.NumberFromString.pipe(Schema.decodeTo(Schema.Int));

/** The id of the process listening on the port, from lsof where it is installed and can see that process. */
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

/** Fails with `PortInUseError`, naming the process listening on the port when it can be found. */
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
 * Refuses a port another process already listens on, before `usine up` builds its runtime.
 * The probe releases the port at once, so a process that takes it afterwards still fails the server's own bind.
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

/** Opens the setup page in a browser; call it only after the HTTP server has bound. */
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
