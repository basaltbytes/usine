import {
  type HostInvocation,
  RemoteShell,
  type SshCommand,
  sshArguments,
} from "@usine/agents/child-host";
import type { SshDestination } from "@usine/core/worker";
import { Effect, Redacted, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  allowlistedEnvironment,
  collectCommand,
  type CommandResult,
  requireSuccess,
} from "../child-command.ts";
import type { ExecutorOperation, ExecutorOperationError } from "../executor.ts";

/**
 * Where a remote command starts, what it exports on top of the machine's own
 * environment, and how its output is cleaned before it is kept: a credential
 * that git or gh echoes is not written to any error, log, or parsed result.
 */
export interface RemoteContext extends Pick<HostInvocation, "cwd" | "environment"> {
  readonly scrub?: (text: string) => string;
}

/** Runs commands on Workers' machines, each as one SSH command through the machine's child host. */
export interface RemoteCommands {
  /** The child host for one machine: the Attempt's children and every command below run through it. */
  readonly shellFor: (ssh: SshCommand, destination: SshDestination) => RemoteShell;
  /** Runs a local command, such as the exe.dev lobby, with only the SSH client's environment. */
  readonly local: (
    operation: ExecutorOperation,
    host: string,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ExecutorOperationError>;
  /** Runs a remote command and returns its exit code and output; the caller decides what the exit code means. */
  readonly inspect: (
    operation: ExecutorOperation,
    shell: RemoteShell,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<CommandResult, ExecutorOperationError>;
  /** Runs a remote command and returns its stdout, or fails when it exits non-zero. */
  readonly run: (
    operation: ExecutorOperation,
    shell: RemoteShell,
    command: string,
    args: ReadonlyArray<string>,
    context?: RemoteContext,
  ) => Effect.Effect<string, ExecutorOperationError>;
  /**
   * Runs a remote command with `input` sent on its standard input, so a
   * secret appears in no command line and is not written to any log.
   */
  readonly runWithInput: (
    operation: ExecutorOperation,
    shell: RemoteShell,
    command: string,
    args: ReadonlyArray<string>,
    input: Redacted.Redacted<string>,
  ) => Effect.Effect<string, ExecutorOperationError>;
}

/**
 * The local SSH client inherits only what SSH itself needs; GitHub and factory
 * credentials from the orchestrator environment are passed neither to it nor to the machine.
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
 * The SSH client every remote Worker uses unless its options replace it. The
 * keepalive pair turns a dead TCP link into a non-zero SSH exit instead of a
 * silent park, so a lost machine fails the operation.
 */
export const DEFAULT_SSH: SshCommand = {
  command: "ssh",
  args: ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"],
};

const encoder = new TextEncoder();

/**
 * `shell` with `variables` set on the machine through the SSH connection
 * (OpenSSH `SendEnv`) rather than in the command line: each value is in the
 * local SSH client's own environment, which only this user and root can
 * read, and in no argument, log, or process listing. The machine's sshd
 * drops every name its `AcceptEnv` does not list.
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

/**
 * The command runner every remote Worker kind uses, bound to this process's
 * spawner and to the allowlisted environment its SSH clients inherit.
 */
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
    return yield* requireSuccess(operation, shell.destination, shell.ssh.command, sshArgs, result);
  });

  return { shellFor, local, inspect, run, runWithInput } satisfies RemoteCommands;
});
