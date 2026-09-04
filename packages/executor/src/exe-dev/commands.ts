import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  allowlistedEnvironment,
  collectCommand,
  requireSuccess,
  type CommandResult,
} from "../child-command.ts";
import type { ExecutorOperation, ExecutorOperationError, RunHostCommand } from "../executor.ts";
import type { SshDestination } from "./model.ts";
import { shellCommand } from "./shell.ts";

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
    sshDest: SshDestination,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<CommandResult, ExecutorOperationError>;
  readonly remote: (
    operation: ExecutorOperation,
    sshDest: SshDestination,
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<string, ExecutorOperationError>;
}

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

export const commandsFor = Effect.fn("ExeDevExecutor.commandsFor")(function* (
  configuredSsh?: RunHostCommand,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* allowlistedEnvironment(SSH_ENVIRONMENT_ALLOWLIST);
  const ssh = configuredSsh ?? {
    command: "ssh",
    // The keepalive pair turns a dead TCP link into a non-zero SSH exit
    // instead of a silent forever-park: a lost VM must fail the operation.
    args: ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"],
  };

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

  // Lobby arguments ride unquoted through OpenSSH's argv join. Every value
  // passed here must be a brand-validated token (Worker.Name,
  // IntegrationName, CredentialGrantMinutes); never pass free-form text.
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
    executeRaw(operation, sshDest, ssh.command, [
      ...ssh.args,
      sshDest,
      "--",
      shellCommand(command, args),
    ]);

  const remote = (
    operation: ExecutorOperation,
    sshDest: SshDestination,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<string, ExecutorOperationError> =>
    executeChecked(operation, sshDest, ssh.command, [
      ...ssh.args,
      sshDest,
      "--",
      shellCommand(command, args),
    ]);

  return {
    environment,
    lobby,
    lobbyJson,
    remote,
    remoteRaw,
    ssh,
  } satisfies ExeDevCommands;
});
