import { Array as Arr, Config, Effect, Fiber, Option, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import { ExecutorOperationError, type ExecutorOperation } from "./executor.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const COMMAND_TIMEOUT = "10 minutes";

/** Returns the variables in `names` that are set in the process environment. */
export const allowlistedEnvironment = (
  names: ReadonlyArray<string>,
): Effect.Effect<Record<string, string>> =>
  Effect.forEach(names, (name) =>
    Effect.map(Config.option(Config.string(name)), (value) =>
      Option.map(value, (found) => [name, found] as const),
    ),
  ).pipe(
    Effect.map((entries) => Object.fromEntries(Arr.getSomes(entries))),
    Effect.orDie,
  );

/**
 * Runs `command` with a 10-minute timeout and returns its exit code and output without checking
 * the exit code. Fails with `ExecutorOperationError` if the command can't run or times out.
 */
export const collectCommand = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  operation: ExecutorOperation,
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions,
): Effect.Effect<CommandResult, ExecutorOperationError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, options));
      const stdoutFiber = yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.forkChild,
      );
      const stderrFiber = yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.forkChild,
      );
      const exitCode = yield* handle.exitCode;
      const [stdout, stderr] = yield* Effect.all([
        Fiber.join(stdoutFiber),
        Fiber.join(stderrFiber),
      ]);
      return { exitCode: Number(exitCode), stderr, stdout } satisfies CommandResult;
    }),
  ).pipe(
    Effect.timeout(COMMAND_TIMEOUT),
    Effect.mapError(
      (cause) =>
        new ExecutorOperationError({
          operation,
          message: `${command} could not be executed`,
          cause,
        }),
    ),
  );

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
    return yield* new ExecutorOperationError({
      operation,
      message: `${command} exited with code ${String(result.exitCode)}`,
      cause: new Error(result.stderr.trim() || `${command} exited without an error message`),
    });
  }
  return result.stdout;
});
