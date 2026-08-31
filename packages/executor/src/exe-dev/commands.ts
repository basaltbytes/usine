import { Array as Arr, Config, Effect, Fiber, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ExecutorOperationError, type ExecutorOperation, type RunHostCommand } from "../index.ts";
import type { VmState } from "./model.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ExeDevCommands {
  readonly environment: Record<string, string>;
  readonly ssh: RunHostCommand;
  readonly lobby: (
    operation: ExecutorOperation,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ExecutorOperationError>;
  readonly lobbyJson: (
    operation: ExecutorOperation,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ExecutorOperationError>;
  readonly remoteRaw: (
    operation: ExecutorOperation,
    vm: VmState,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<CommandResult, ExecutorOperationError>;
  readonly remote: (
    operation: ExecutorOperation,
    vm: VmState,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ExecutorOperationError>;
}

const COMMAND_TIMEOUT = "10 minutes";

/**
 * The local SSH process receives only what SSH itself needs. In particular,
 * GitHub and factory credentials from the orchestrator environment never
 * cross into either the SSH client or the VM.
 */
const SSH_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SHELL",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
  "TMPDIR",
  "USER",
] as const;

const sshEnvironment: Effect.Effect<Record<string, string>> = Effect.forEach(
  SSH_ENVIRONMENT_ALLOWLIST,
  (name) =>
    Effect.map(Config.option(Config.string(name)), (value) =>
      Option.map(value, (found) => [name, found] as const),
    ),
).pipe(
  Effect.map((entries) => Object.fromEntries(Arr.getSomes(entries))),
  Effect.orDie,
);

const executorError = (
  operation: ExecutorOperation,
  message: string,
  cause: unknown,
): ExecutorOperationError => new ExecutorOperationError({ operation, message, cause });

export const commandsFor = Effect.fn("ExeDevExecutor.commandsFor")(function* (
  configuredSsh?: RunHostCommand,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* sshEnvironment;
  const ssh = configuredSsh ?? {
    command: "ssh",
    args: ["-o", "BatchMode=yes"],
  };

  const executeRaw = Effect.fn("ExeDevExecutor.executeRaw")(function* (
    operation: ExecutorOperation,
    command: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            env: environment,
            extendEnv: false,
          }),
        );
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
        return {
          exitCode: Number(exitCode),
          stderr,
          stdout,
        } satisfies CommandResult;
      }),
    ).pipe(
      Effect.timeout(COMMAND_TIMEOUT),
      Effect.mapError((cause) =>
        executorError(operation, `${command} could not be executed`, cause),
      ),
    );
  });

  const executeChecked = Effect.fn("ExeDevExecutor.executeChecked")(function* (
    operation: ExecutorOperation,
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* executeRaw(operation, command, args);
    if (result.exitCode !== 0) {
      yield* Effect.logWarning("exe.dev command exited non-zero", {
        operation,
        command,
        exitCode: String(result.exitCode),
      });
      return yield* executorError(
        operation,
        `${command} exited with code ${String(result.exitCode)}`,
        new Error(result.stderr.trim() || `${command} exited without an error message`),
      );
    }
    return result.stdout;
  });

  const lobby = (
    operation: ExecutorOperation,
    args: ReadonlyArray<string>,
  ): Effect.Effect<string, ExecutorOperationError> =>
    executeChecked(operation, ssh.command, [...ssh.args, "exe.dev", ...args]);

  const lobbyJson = (
    operation: ExecutorOperation,
    args: ReadonlyArray<string>,
  ): Effect.Effect<string, ExecutorOperationError> => lobby(operation, [...args, "--json"]);

  const remoteRaw = (
    operation: ExecutorOperation,
    vm: VmState,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<CommandResult, ExecutorOperationError> =>
    executeRaw(operation, ssh.command, [...ssh.args, vm.sshDest, "--", command, ...args]);

  const remote = (
    operation: ExecutorOperation,
    vm: VmState,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<string, ExecutorOperationError> =>
    executeChecked(operation, ssh.command, [...ssh.args, vm.sshDest, "--", command, ...args]);

  return {
    environment,
    lobby,
    lobbyJson,
    remote,
    remoteRaw,
    ssh,
  } satisfies ExeDevCommands;
});
