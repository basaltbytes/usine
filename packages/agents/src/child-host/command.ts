import { Effect, Option, type PlatformError, type Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import {
  type ChildHost,
  type HostCommandOptions,
  type HostInvocation,
  HostUnreachable,
  remoteInput,
  sshArguments,
  SSH_FAILURE,
} from "./child-host.ts";
import { execHandle, unreachableCause } from "./exec.ts";

/**
 * Returns the local process command that runs `invocation` on `host`: the command itself with
 * exactly `environment` on a local host, or one SSH command whose client gets only `sshEnvironment`
 * on a remote shell. Throws if `environment` is not empty on a remote shell, or if `host` is an
 * `ExecShell`, which runs commands in this process: start those with `hostSpawn`.
 */
export const hostCommand = (
  host: ChildHost,
  invocation: HostInvocation & { readonly environment: Readonly<Record<string, string>> },
  options: HostCommandOptions,
): ChildProcess.Command => {
  switch (host._tag) {
    case "LocalProcess":
      return ChildProcess.make(invocation.command, invocation.args, {
        ...options,
        cwd: invocation.cwd ?? homedir(),
        env: { ...invocation.environment },
        extendEnv: false,
      });
    case "RemoteShell": {
      const names = Object.keys(invocation.environment);
      if (names.length > 0)
        throw new Error(`Cannot pass ${names.join(", ")} to a remote command on its command line`);
      const remoteOptions =
        host.stdinEnvironment === undefined
          ? options
          : {
              ...options,
              stdin: {
                ...options.stdin,
                stream: remoteInput(host, options.stdin?.stream ?? Stream.empty),
              },
            };
      return ChildProcess.make(host.ssh.command, sshArguments(host, invocation), {
        ...remoteOptions,
        env: { ...host.sshEnvironment },
        extendEnv: false,
      });
    }
    case "ExecShell":
      throw new Error(`Cannot make a local command for exec shell ${host.destination}`);
  }
};

/**
 * Starts `invocation` on `host` and returns its handle: a local process for a local host or a
 * remote shell, or an `ExecShell` command in this process. On an `ExecShell`, `exitCode` fails with
 * a `PlatformError` whose cause is `HostUnreachable` if the transport loses the command; read
 * `stdout` and `stderr` to their end first, since they keep every byte received. Dies if
 * `environment` is not empty on a remote host.
 */
export const hostSpawn = (
  host: ChildHost,
  invocation: HostInvocation & { readonly environment: Readonly<Record<string, string>> },
  options: HostCommandOptions,
): Effect.Effect<
  ChildProcessSpawner.ChildProcessHandle,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  host._tag === "ExecShell"
    ? execHandle(host, invocation, options)
    : ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        spawner.spawn(hostCommand(host, invocation, options)),
      );

/** The trimmed standard output and the exit code of a command on a host. */
interface HostOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Runs `invocation` on `host` and returns its trimmed stdout and exit code; stderr is discarded.
 * Fails with `HostUnreachable` if a remote host can't run the command or loses it: an SSH client
 * that exits with `SSH_FAILURE`, or an `ExecShell` transport failure.
 */
export const hostOutput = Effect.fn("ChildHost.output")(function* (
  host: ChildHost,
  invocation: HostInvocation & { readonly environment: Readonly<Record<string, string>> },
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* hostSpawn(host, invocation, {
        detached: false,
        forceKillAfter: "2 seconds",
      });
      const [stdout, stderr] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = yield* handle.exitCode.pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail<PlatformError.PlatformError | HostUnreachable>(
            Option.getOrElse(unreachableCause(error), () => error),
          ),
        ),
      );
      if (host._tag === "RemoteShell" && exitCode === SSH_FAILURE)
        return yield* HostUnreachable.make({
          destination: host.destination,
          message: stderr.trim() || `${host.ssh.command} exited with code ${SSH_FAILURE}`,
        });
      return { stdout: stdout.trim(), exitCode } satisfies HostOutput;
    }),
  );
});
