/**
 * The shared body of a program that stands in for `ssh` as the `SshCommand` of a `RemoteShell`,
 * under the contract that `SshCommand` documents in `@usine/agents/child-host`: argument parsing,
 * the relay of the standard streams, and the exit code. A stand-in supplies only its transport.
 */
// Imports only light modules: a stand-in starts once per remote command.
import { type Brand, Cause, Effect, Exit, Option, References, Schema, Stream } from "effect";

/** The exit code of a stand-in that can't reach the machine or follow its command, as OpenSSH uses it. */
export const TRANSPORT_FAILURE = 255;

/** What a stand-in runs: one command line on one destination. */
export interface StandInCommand {
  readonly destination: string;
  /** The command line for the remote POSIX shell, as one argument. */
  readonly line: string;
}

/**
 * Returns the command in a stand-in's arguments, `[-o <option>]... <destination> -- <command line>`,
 * or `None` if they have another form. The `-o` options are OpenSSH's, and a stand-in ignores them.
 */
export const parseStandInArguments = (
  args: ReadonlyArray<string>,
): Option.Option<StandInCommand> => {
  const separator = args.indexOf("--");
  if (separator < 1 || separator !== args.length - 2) return Option.none();
  const options = args.slice(0, separator - 1);
  const pairs =
    options.length % 2 === 0 && options.every((word, index) => index % 2 === 1 || word === "-o");
  const destination = args[separator - 1] ?? "";
  const line = args[separator + 1] ?? "";
  return pairs && destination !== "" && !destination.startsWith("-") && line !== ""
    ? Option.some({ destination, line })
    : Option.none();
};

/** The error when a stand-in can't reach the machine or follow its command. It exits 255. */
export class StandInFailure extends Schema.TaggedError<
  StandInFailure,
  Brand.Brand<"@usine/executor/remote/stand-in/StandInFailure">
>()("StandInFailure", {
  /** What went wrong, written to stderr; never contains a credential. */
  message: Schema.String,
}) {}

/** The standard streams of the stand-in process. */
export interface StandInStreams {
  /** The stand-in's stdin, which the remote command reads. It has one reader. */
  readonly stdin: Stream.Stream<Uint8Array>;
  /** Writes to the stand-in's stdout, waiting while the reader is behind. */
  readonly stdout: (bytes: Uint8Array) => Effect.Effect<void>;
  /** Writes to the stand-in's stderr, waiting while the reader is behind. */
  readonly stderr: (bytes: Uint8Array) => Effect.Effect<void>;
}

const writer =
  (stream: NodeJS.WriteStream) =>
  (bytes: Uint8Array): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      if (stream.write(bytes)) resume(Effect.void);
      else stream.once("drain", () => resume(Effect.void));
    });

/**
 * Runs a stand-in named `name` in this process: parses its arguments, runs `relay`, and exits with
 * the code that `relay` returns, or with 255 and a message on stderr if the arguments have another
 * form or `relay` fails. A defect exits 255 with a fixed message, since its text can contain a
 * credential. Logs are off, so stdout and stderr carry only the remote command's output.
 */
export const runStandIn = (
  name: string,
  relay: (
    command: StandInCommand,
    streams: StandInStreams,
  ) => Effect.Effect<number, StandInFailure>,
): void => {
  const finish = (code: number, message?: string) => {
    if (message !== undefined) process.stderr.write(`${name}: ${message}\n`);
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  };
  const command = parseStandInArguments(process.argv.slice(2));
  if (Option.isNone(command)) {
    finish(TRANSPORT_FAILURE, "expected [-o option]... <destination> -- <command line>");
    return;
  }
  const streams: StandInStreams = {
    // A read error ends stdin, as it does for OpenSSH.
    stdin: Stream.fromAsyncIterable<Uint8Array, void>(process.stdin, () => undefined).pipe(
      Stream.catch(() => Stream.empty),
    ),
    stdout: writer(process.stdout),
    stderr: writer(process.stderr),
  };
  Effect.runFork(
    relay(command.value, streams).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
  ).addObserver((exit) => {
    if (Exit.isSuccess(exit)) return finish(exit.value);
    finish(
      TRANSPORT_FAILURE,
      Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "the command stream failed unexpectedly",
        onSome: (failure) => failure.message,
      }),
    );
  });
};
