import type { RemoteShell, SshCommand } from "@usine/agents/child-host";
import type { SshDestination } from "@usine/core/worker";
import { Effect } from "effect";
import type { CommandResult } from "../child-command.ts";
import type { ExecutorOperation, ExecutorOperationError } from "../executor.ts";
import {
  DEFAULT_SSH,
  type RemoteCommands,
  type RemoteContext,
  remoteCommandsFor,
} from "../remote/commands.ts";

export interface ExeDevCommands {
  /** The shared remote command runner every VM command goes through. */
  readonly shared: RemoteCommands;
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

export const commandsFor = Effect.fn("ExeDevExecutor.commandsFor")(function* (
  configuredSsh?: SshCommand,
) {
  const shared = yield* remoteCommandsFor;
  const ssh = configuredSsh ?? DEFAULT_SSH;
  const childHost = (sshDest: SshDestination) => shared.shellFor(ssh, sshDest);

  // Lobby arguments pass unquoted through OpenSSH's argv join, so every value
  // must be a brand-validated token (WorkerName, IntegrationName,
  // CredentialGrantMinutes), never free-form text.
  const lobby = (
    operation: ExecutorOperation,
    args: ReadonlyArray<string>,
  ): Effect.Effect<string, ExecutorOperationError> =>
    shared.local(operation, "exe.dev", ssh.command, [...ssh.args, "exe.dev", ...args]);

  const lobbyJson = (
    operation: ExecutorOperation,
    args: ReadonlyArray<string>,
  ): Effect.Effect<string, ExecutorOperationError> => lobby(operation, [...args, "--json"]);

  return {
    shared,
    childHost,
    lobby,
    lobbyJson,
    remoteRaw: (operation, sshDest, command, args) =>
      shared.inspect(operation, childHost(sshDest), command, args),
    remote: (operation, sshDest, command, args, context) =>
      shared.run(operation, childHost(sshDest), command, args, context),
  } satisfies ExeDevCommands;
});
