import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { homedir } from "node:os";
import { type ChildHost, type HostInvocation, sshArguments } from "./child-host.ts";

/**
 * Returns the local process command that runs `invocation` on `host`: the command itself with
 * exactly `environment` on a local host, or one SSH command whose client gets only `sshEnvironment`
 * on a remote host.
 */
export const hostCommand = (
  host: ChildHost,
  invocation: HostInvocation & { readonly environment: Readonly<Record<string, string>> },
  options: ChildProcess.CommandOptions,
): ChildProcess.Command => {
  switch (host._tag) {
    case "LocalProcess":
      return ChildProcess.make(invocation.command, invocation.args, {
        ...options,
        cwd: invocation.cwd ?? homedir(),
        env: { ...invocation.environment },
        extendEnv: false,
      });
    case "RemoteShell":
      return ChildProcess.make(host.ssh.command, sshArguments(host, invocation), {
        ...options,
        env: { ...host.sshEnvironment },
        extendEnv: false,
      });
  }
};

/** The trimmed standard output and the exit code of a command on a host. */
interface HostOutput {
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Runs `invocation` on `host` and returns its trimmed stdout and exit code; stderr is discarded. On
 * a remote host, `SSH_FAILURE` means that SSH failed, not the command.
 */
export const hostOutput = Effect.fn("ChildHost.output")(function* (
  host: ChildHost,
  invocation: HostInvocation & { readonly environment: Readonly<Record<string, string>> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        hostCommand(host, invocation, { detached: false, forceKillAfter: "2 seconds" }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.runDrain),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout: stdout.trim(), exitCode } satisfies HostOutput;
    }),
  );
});
