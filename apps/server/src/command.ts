import { Duration, Effect, Fiber, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** The exit code and output of a finished command. */
interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A command couldn't run, timed out, or exited non-zero. */
export class CommandError extends Schema.TaggedError<CommandError>("@usine/server/CommandError")(
  "CommandError",
  { command: Schema.String, reason: Schema.String },
) {}

const commandLine = (command: string, args: ReadonlyArray<string>) => [command, ...args].join(" ");

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** Runs a command in `cwd` and returns its output. Fails if it exits non-zero or times out. */
export const runCommand = Effect.fn("Cli.runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeout: Duration.Input,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const line = commandLine(command, args);
  yield* Effect.annotateCurrentSpan({ command: line, cwd });
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { cwd, stdin: "ignore" }),
      );
      const stdout = yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.forkChild,
      );
      const stderr = yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.forkChild,
      );
      const exitCode = Number(yield* handle.exitCode);
      const [out, err] = yield* Effect.all([Fiber.join(stdout), Fiber.join(stderr)]);
      return { exitCode, stdout: out, stderr: err } satisfies CommandResult;
    }),
  ).pipe(
    Effect.timeout(timeout),
    Effect.mapError((cause) => new CommandError({ command: line, reason: cause.message })),
  );
  if (result.exitCode !== 0) {
    const reason = `exited with status ${result.exitCode}: ${firstLine(result.stderr) || firstLine(result.stdout)}`;
    yield* Effect.logWarning("A command exited non-zero", { command: line, reason });
    return yield* new CommandError({ command: line, reason });
  }
  return result;
});

/**
 * Runs a command in `cwd` with the terminal as its standard output and error, so that the operator
 * sees its progress. Fails if it exits non-zero.
 */
export const runInTerminal = Effect.fn("Cli.runInTerminal")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const line = commandLine(command, args);
  yield* Effect.annotateCurrentSpan({ command: line, cwd });
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(command, args, {
        cwd,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(Effect.mapError((cause) => new CommandError({ command: line, reason: cause.message })));
  if (Number(exitCode) !== 0) {
    return yield* new CommandError({
      command: line,
      reason: `exited with status ${Number(exitCode)}`,
    });
  }
});
