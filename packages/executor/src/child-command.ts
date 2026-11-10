import { HostUnreachable } from "@usine/agents/child-host";
import {
  Array as Arr,
  type Brand,
  Cause,
  Config,
  Effect,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { ExecutorOperationError, type ExecutorOperation } from "./executor.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const COMMAND_TIMEOUT = "10 minutes";

export class CommandOutputLimitExceeded extends Schema.TaggedError<
  CommandOutputLimitExceeded,
  Brand.Brand<"@usine/executor/child-command/CommandOutputLimitExceeded">
>()("CommandOutputLimitExceeded", {
  maxBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

const readText = <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number | undefined) =>
  Effect.suspend(() => {
    let bytes = 0;
    return stream.pipe(
      Stream.mapEffect((chunk) => {
        bytes += chunk.byteLength;
        return maxBytes !== undefined && bytes > maxBytes
          ? Effect.fail(CommandOutputLimitExceeded.make({ maxBytes }))
          : Effect.succeed(chunk);
      }),
      Stream.decodeText(),
      Stream.mkString,
    );
  });

/** Returns the variables in `names` that are set in the process environment. */
export const allowlistedEnvironment = (
  names: ReadonlyArray<string>,
): Effect.Effect<Record<string, string>> =>
  Effect.forEach(names, (name) =>
    Effect.map(Config.option(Config.String(name)), (value) =>
      Option.map(value, (found) => [name, found] as const),
    ),
  ).pipe(
    Effect.map((entries) => Object.fromEntries(Arr.getSomes(entries))),
    Effect.orDie,
  );

/** A started command's output and exit code. */
interface StartedCommand<E> {
  readonly stdout: Stream.Stream<Uint8Array, E>;
  readonly stderr: Stream.Stream<Uint8Array, E>;
  readonly exitCode: Effect.Effect<number, E>;
}

/**
 * Starts a command with `start`, reads its stdout and stderr to their end, then its exit code, with
 * a 10-minute timeout, and returns them without checking the exit code. When `maxOutputBytes` is
 * set, caps each output stream before decoding it. Fails with `ExecutorOperationError`, which
 * names `command`, if the command can't run or times out; the cause is `HostUnreachable` if a host
 * couldn't run it or lost it.
 */
export const collectOutput = <E>(
  operation: ExecutorOperation,
  command: string,
  start: Effect.Effect<StartedCommand<E>, E, Scope.Scope>,
  maxOutputBytes?: number,
): Effect.Effect<CommandResult, ExecutorOperationError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* start;
      const [stdout, stderr] = yield* Effect.all(
        [readText(started.stdout, maxOutputBytes), readText(started.stderr, maxOutputBytes)],
        { concurrency: "unbounded" },
      );
      const exitCode = yield* started.exitCode;
      return { exitCode: Number(exitCode), stderr, stdout } satisfies CommandResult;
    }),
  ).pipe(
    Effect.timeout(COMMAND_TIMEOUT),
    Effect.mapError((cause) =>
      ExecutorOperationError.make({
        operation,
        message: Cause.isTimeoutError(cause)
          ? `${command} didn't finish within ${COMMAND_TIMEOUT}`
          : Schema.is(CommandOutputLimitExceeded)(cause)
            ? `${command} output exceeds ${cause.maxBytes} bytes`
            : Schema.is(HostUnreachable)(cause)
              ? `Can't reach ${cause.destination} to run ${command}: ${cause.message}`
              : `Can't run ${command}`,
        cause,
      }),
    ),
  );

/**
 * Runs `command` with a 10-minute timeout and returns its exit code and output without checking
 * the exit code. When `maxOutputBytes` is set, caps each output stream before decoding it.
 * Fails with `ExecutorOperationError` if the command can't run or times out.
 */
export const collectCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  operation: ExecutorOperation,
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions,
  maxOutputBytes?: number,
): Effect.Effect<CommandResult, ExecutorOperationError> =>
  collectOutput(
    operation,
    command,
    spawner.spawn(ChildProcess.make(command, args, options)),
    maxOutputBytes,
  );

/** Returns whether `error` reports that a remote host couldn't run a command or lost it. */
export const unreachableHost = (error: ExecutorOperationError): boolean =>
  Schema.is(HostUnreachable)(error.cause);

/** Returns the collected stdout. If the exit code is non-zero, logs a warning and fails with `ExecutorOperationError`. */
export const requireSuccess = Effect.fn("Executor.requireSuccess")(function* (
  operation: ExecutorOperation,
  host: string,
  command: string,
  args: ReadonlyArray<string>,
  result: CommandResult,
) {
  if (result.exitCode !== 0) {
    yield* Effect.logWarning("Executor command exited non-zero", {
      operation,
      host,
      command,
      args: args.join(" "),
      exitCode: String(result.exitCode),
    });
    return yield* ExecutorOperationError.make({
      operation,
      message: `${command} exited with code ${String(result.exitCode)}`,
      cause: new Error(result.stderr.trim() || `${command} exited without an error message`),
    });
  }
  return result.stdout;
});
