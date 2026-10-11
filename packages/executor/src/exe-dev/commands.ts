import { RemoteShell, type RemoteInvocation, sshArguments } from "@usine/agents/child-host";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  allowlistedEnvironment,
  collectCommand,
  requireSuccess,
  type CommandResult,
} from "../child-command.ts";
import type { ExecutorOperation, ExecutorOperationError, SshCommand } from "../executor.ts";
import type { SshDestination } from "./model.ts";

/** Where a remote command starts and what it exports on top of the VM's own environment. */
export type RemoteContext = Pick<RemoteInvocation, "cwd" | "environment">;

export interface ExeDevCommands {
  readonly environment: Record<string, string>;
  readonly ssh: SshCommand;
  /** The child host that runs an Attempt's children on this VM through the same SSH client. */
  readonly childHost: (sshDest: SshDestination) => RemoteShell;
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
    sshDest: SshDestination,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<CommandResult, ExecutorOperationError>;
  readonly remote: (
    operation: ExecutorOperation,
    sshDest: SshDestination,
    command: string,
    args: ReadonlyArray<string>,
    context?: RemoteContext,
  ) => Effect.Effect<string, ExecutorOperationError>;
}

/**
 * The local SSH client inherits only what SSH itself needs; GitHub and factory
 * credentials from the orchestrator environment never reach it or the VM.
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

export const commandsFor = Effect.fn("ExeDevExecutor.commandsFor")(function* (
  configuredSsh?: SshCommand,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* allowlistedEnvironment(SSH_ENVIRONMENT_ALLOWLIST);
  const ssh = configuredSsh ?? {
    command: "ssh",
    // The keepalive pair turns a dead TCP link into a non-zero SSH exit instead
    // of a silent park, so a lost VM fails the operation.
    args: ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"],
  };

  const childHost = (sshDest: SshDestination) =>
    new RemoteShell({ ssh, sshEnvironment: environment, destination: sshDest });

  const executeRaw = Effect.fn("ExeDevExecutor.executeRaw")(function* (
    operation: ExecutorOperation,
    host: string,
    command: string,
    args: ReadonlyArray<string>,
  ) {
    yield* Effect.annotateCurrentSpan({ host, operation });
    return yield* collectCommand(spawner, operation, command, args, {
      env: environment,
      extendEnv: false,
    });
  });

  const executeChecked = Effect.fn("ExeDevExecutor.executeChecked")(function* (
    operation: ExecutorOperation,
    host: string,
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* executeRaw(operation, host, command, args);
    return yield* requireSuccess(operation, host, command, args, result);
  });

  // Lobby arguments pass unquoted through OpenSSH's argv join, so every value
  // must be a brand-validated token (WorkerName, IntegrationName,
  // CredentialGrantMinutes), never free-form text.
  const lobby = (
    operation: ExecutorOperation,
    args: ReadonlyArray<string>,
  ): Effect.Effect<string, ExecutorOperationError> =>
    executeChecked(operation, "exe.dev", ssh.command, [...ssh.args, "exe.dev", ...args]);

  const lobbyJson = (
    operation: ExecutorOperation,
    args: ReadonlyArray<string>,
  ): Effect.Effect<string, ExecutorOperationError> => lobby(operation, [...args, "--json"]);

  const remoteRaw = (
    operation: ExecutorOperation,
    sshDest: SshDestination,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<CommandResult, ExecutorOperationError> =>
    executeRaw(
      operation,
      sshDest,
      ssh.command,
      sshArguments(childHost(sshDest), { command, args }),
    );

  const remote = (
    operation: ExecutorOperation,
    sshDest: SshDestination,
    command: string,
    args: ReadonlyArray<string>,
    context: RemoteContext = {},
  ): Effect.Effect<string, ExecutorOperationError> =>
    executeChecked(
      operation,
      sshDest,
      ssh.command,
      sshArguments(childHost(sshDest), { ...context, command, args }),
    );

  return {
    childHost,
    environment,
    lobby,
    lobbyJson,
    remote,
    remoteRaw,
    ssh,
  } satisfies ExeDevCommands;
});
