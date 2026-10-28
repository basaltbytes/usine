import {
  type HostInvocation,
  RemoteShell,
  type SshCommand,
  sshArguments,
} from "@usine/agents/child-host";
import type { SshDestination } from "@usine/core/worker";
import { Effect, Redacted, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  allowlistedEnvironment,
  collectCommand,
  type CommandResult,
  requireSuccess,
} from "../child-command.ts";
import type { ExecutorOperation, ExecutorOperationError } from "../executor.ts";

/**
 * The working directory and extra environment for a remote command. `scrub` is applied to the
 * output first, so a credential printed by git or gh isn't kept in any error, log, or parsed
 * result.
 */
export interface RemoteContext extends Pick<HostInvocation, "cwd" | "environment"> {
  readonly scrub?: (text: string) => string;
}

export interface RemoteCommands {
  /** Returns the shell for one machine, used by the Attempt's children and the commands below. */
  readonly shellFor: (ssh: SshCommand, destination: SshDestination) => RemoteShell;
  /** Runs a local command, such as the exe.dev lobby, with only the SSH client's environment. */
  readonly local: (
    operation: ExecutorOperation,
    host: string,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ExecutorOperationError>;
  /** Runs a remote command and returns its exit code and output without checking the exit code. */
  readonly inspect: (
    operation: ExecutorOperation,
    shell: RemoteShell,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<CommandResult, ExecutorOperationError>;
  /** Runs a remote command and returns its stdout. Fails if it exits non-zero. */
  readonly run: (
    operation: ExecutorOperation,
    shell: RemoteShell,
    command: string,
    args: ReadonlyArray<string>,
    context?: RemoteContext,
  ) => Effect.Effect<string, ExecutorOperationError>;
  /** Runs a remote command with `input` on stdin, so a secret isn't in the command line or logs. */
  readonly runWithInput: (
    operation: ExecutorOperation,
    shell: RemoteShell,
    command: string,
    args: ReadonlyArray<string>,
    input: Redacted.Redacted<string>,
  ) => Effect.Effect<string, ExecutorOperationError>;
}

/**
 * The variables the local SSH client inherits. GitHub and factory credentials in the
 * orchestrator environment aren't passed to the client or the machine.
 */
export const SSH_ENVIRONMENT_ALLOWLIST = [
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

/**
 * The default SSH client for remote Workers. Its keepalive options make a dead TCP connection
 * exit non-zero instead of hanging.
 */
export const DEFAULT_SSH: SshCommand = {
  command: "ssh",
  args: ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"],
};

const encoder = new TextEncoder();

/**
 * Returns `shell` with `variables` sent through OpenSSH `SendEnv` instead of the command line,
 * so the values aren't in arguments, logs, or process listings. The remote sshd drops names
 * not in its `AcceptEnv`.
 */
export const sendingShell = (
  shell: RemoteShell,
  variables: Readonly<Record<string, Redacted.Redacted<string>>>,
): RemoteShell => {
  const entries = Object.entries(variables);
  if (entries.length === 0) return shell;
  return new RemoteShell({
    ssh: {
      command: shell.ssh.command,
      args: [...shell.ssh.args, "-o", `SendEnv=${entries.map(([name]) => name).join(" ")}`],
    },
    sshEnvironment: {
      ...shell.sshEnvironment,
      ...Object.fromEntries(entries.map(([name, value]) => [name, Redacted.value(value)])),
    },
    destination: shell.destination,
  });
};

/** The `RemoteCommands` that use this process's spawner and the allowlisted SSH environment. */
export const remoteCommandsFor = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* allowlistedEnvironment(SSH_ENVIRONMENT_ALLOWLIST);

  const shellFor = (ssh: SshCommand, destination: SshDestination) =>
    new RemoteShell({ ssh, sshEnvironment: environment, destination });

  const executeRaw = Effect.fn("RemoteExecutor.executeRaw")(function* (
    operation: ExecutorOperation,
    host: string,
    command: string,
    args: ReadonlyArray<string>,
    clientEnvironment: Readonly<Record<string, string>>,
  ) {
    yield* Effect.annotateCurrentSpan({ host, operation });
    return yield* collectCommand(spawner, operation, command, args, {
      env: { ...clientEnvironment },
      extendEnv: false,
    });
  });

  const local = Effect.fn("RemoteExecutor.local")(function* (
    operation: ExecutorOperation,
    host: string,
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* executeRaw(operation, host, command, args, environment);
    return yield* requireSuccess(operation, host, command, args, result);
  });

  const inspect = (
    operation: ExecutorOperation,
    shell: RemoteShell,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<CommandResult, ExecutorOperationError> =>
    executeRaw(
      operation,
      shell.destination,
      shell.ssh.command,
      sshArguments(shell, { command, args }),
      shell.sshEnvironment,
    );

  const run = Effect.fn("RemoteExecutor.run")(function* (
    operation: ExecutorOperation,
    shell: RemoteShell,
    command: string,
    args: ReadonlyArray<string>,
    context: RemoteContext = {},
  ) {
    const sshArgs = sshArguments(shell, {
      cwd: context.cwd,
      environment: context.environment,
      command,
      args,
    });
    const result = yield* executeRaw(
      operation,
      shell.destination,
      shell.ssh.command,
      sshArgs,
      shell.sshEnvironment,
    );
    const scrub = context.scrub ?? ((text: string) => text);
    return yield* requireSuccess(operation, shell.destination, shell.ssh.command, sshArgs, {
      ...result,
      stdout: scrub(result.stdout),
      stderr: scrub(result.stderr),
    });
  });

  const runWithInput = Effect.fn("RemoteExecutor.runWithInput")(function* (
    operation: ExecutorOperation,
    shell: RemoteShell,
    command: string,
    args: ReadonlyArray<string>,
    input: Redacted.Redacted<string>,
  ) {
    yield* Effect.annotateCurrentSpan({ host: shell.destination, operation });
    const sshArgs = sshArguments(shell, { command, args });
    const result = yield* collectCommand(spawner, operation, shell.ssh.command, sshArgs, {
      env: { ...shell.sshEnvironment },
      extendEnv: false,
      stdin: Stream.make(encoder.encode(Redacted.value(input))),
    });
    const secret = Redacted.value(input);
    const scrub = (text: string) => (secret === "" ? text : text.replaceAll(secret, "[REDACTED]"));
    return yield* requireSuccess(operation, shell.destination, shell.ssh.command, sshArgs, {
      ...result,
      stdout: scrub(result.stdout),
      stderr: scrub(result.stderr),
    });
  });

  return { shellFor, local, inspect, run, runWithInput } satisfies RemoteCommands;
});
