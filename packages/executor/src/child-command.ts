import { Array as Arr, Config, Effect, Fiber, Option, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import { ExecutorOperationError, type ExecutorOperation } from "./executor.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Bounds every adapter command so a hung clone or SSH hop stays cancellable. */
const COMMAND_TIMEOUT = "10 minutes";

/**
 * Returns only the named process variables, so the App private key and every
 * other orchestrator secret stay out of the child.
 */
export const allowlistedEnvironment = (
  names: ReadonlyArray<string>,
): Effect.Effect<Record<string, string>> =>
  Effect.forEach(names, (name) =>
    Effect.map(Config.option(Config.string(name)), (value) =>
      Option.map(value, (found) => [name, found] as const),
    ),
  ).pipe(
    Effect.map((entries) => Object.fromEntries(Arr.getSomes(entries))),
    // An unreadable process environment at layer build is a defect, not a failure to handle.
    Effect.orDie,
  );

/**
 * Runs one child process under the timeout and returns its whole output; the
 * caller decides what the exit code means.
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

/** Returns the collected stdout, or logs and fails when the exit code is non-zero. */
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
