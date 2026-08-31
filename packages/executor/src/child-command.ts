import { Array as Arr, Config, Effect, Fiber, Option, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import { ExecutorOperationError, type ExecutorOperation } from "./index.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Every adapter command is bounded: a hung clone or SSH hop must stay cancellable. */
const COMMAND_TIMEOUT = "10 minutes";

/**
 * The named variables are the only ones a child may inherit; everything else
 * in the orchestrator environment — the App private key above all — stays out.
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
    // An unreadable process environment at layer build is startup breakage.
    Effect.orDie,
  );

/** One bounded child process, output collected whole; the exit code is the caller's. */
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

/** Turns a collected result into stdout, logging and failing on a non-zero exit. */
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
