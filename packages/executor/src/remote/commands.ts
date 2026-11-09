import {
  type HostInvocation,
  RemoteShell,
  type SshCommand,
  sshArguments,
  sshInput,
} from "@usine/agents/child-host";
import { jsonKey } from "@usine/core/json-key";
import type { SshDestination, WorkerName } from "@usine/core/worker";
import { Effect, Option, Redacted, Stream, SynchronizedRef } from "effect";
import { ChildProcessSpawner } from "effect/process";
import {
  allowlistedEnvironment,
  collectCommand,
  type CommandResult,
  requireSuccess,
} from "../child-command.ts";
import { type ExecutorOperation, ExecutorOperationError } from "../executor.ts";

/**
 * The working directory and extra environment for a remote command. `scrub` is applied to the
 * output first, so a credential printed by git or gh isn't kept in any error, log, or parsed
 * result.
 */
export interface RemoteContext extends Pick<HostInvocation, "cwd" | "environment"> {
  readonly maxOutputBytes?: number | undefined;
  readonly scrub?: (text: string) => string;
}

export interface RemoteCommands {
  /** Selects and verifies a secret variable transport; `probe` refreshes the preflight result. */
  readonly sendingShell: (
    worker: WorkerName,
    shell: RemoteShell,
    variables: Readonly<Record<string, Redacted.Redacted<string>>>,
    selection?: "cached" | "probe",
  ) => Effect.Effect<RemoteShell, ExecutorOperationError>;
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

const connectionArgs = (args: ReadonlyArray<string>) =>
  args.filter(
    (arg, index) =>
      !arg.startsWith("SendEnv=") &&
      !(arg === "-o" && args[index + 1]?.startsWith("SendEnv=") === true),
  );

/**
 * Adds secrets through the selected transport, outside command arguments.
 */
const sendingShell = (
  shell: RemoteShell,
  variables: Readonly<Record<string, Redacted.Redacted<string>>>,
  transport: "sendenv" | "stdin",
): RemoteShell => {
  const entries = Object.entries(variables);
  if (entries.length === 0) return shell;
  if (transport === "stdin" || shell.stdinEnvironment !== undefined) {
    const names = shell.ssh.args.flatMap((arg) =>
      arg.startsWith("SendEnv=") ? arg.slice("SendEnv=".length).split(" ") : [],
    );
    const inherited = Object.fromEntries(
      names.flatMap((name) => {
        const value = shell.sshEnvironment[name];
        return value === undefined ? [] : [[name, Redacted.make(value)]];
      }),
    );
    return RemoteShell.make({
      ...shell,
      ssh: {
        ...shell.ssh,
        args: connectionArgs(shell.ssh.args),
      },
      sshEnvironment: Object.fromEntries(
        Object.entries(shell.sshEnvironment).filter(([name]) => !names.includes(name)),
      ),
      stdinEnvironment: { ...inherited, ...shell.stdinEnvironment, ...variables },
    });
  }
  return RemoteShell.make({
    ...shell,
    ssh: {
      command: shell.ssh.command,
      args: [...shell.ssh.args, "-o", `SendEnv=${entries.map(([name]) => name).join(" ")}`],
    },
    sshEnvironment: {
      ...shell.sshEnvironment,
      ...Object.fromEntries(entries.map(([name, value]) => [name, Redacted.value(value)])),
    },
  });
};

interface VariableTransport {
  readonly transport: "sendenv" | "stdin";
  readonly names: ReadonlyArray<string>;
}

const SENT_VARIABLES_SCRIPT = `
while [ "$#" -gt 1 ]; do
  test "$(printenv "$1")" = "$2" || echo "$1"
  shift 2
done
`.trim();

/** The `RemoteCommands` that use this process's spawner and the allowlisted SSH environment. */
export const remoteCommandsFor = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* allowlistedEnvironment(SSH_ENVIRONMENT_ALLOWLIST);
  const transports = new Map<
    string,
    SynchronizedRef.SynchronizedRef<Option.Option<VariableTransport>>
  >();
  const logged = new Set<WorkerName>();

  const shellFor = (ssh: SshCommand, destination: SshDestination) =>
    RemoteShell.make({ ssh, sshEnvironment: environment, destination });

  const executeRaw = Effect.fn("RemoteExecutor.executeRaw")(function* (
    operation: ExecutorOperation,
    host: string,
    command: string,
    args: ReadonlyArray<string>,
    clientEnvironment: Readonly<Record<string, string>>,
    maxOutputBytes?: number,
    input: Stream.Stream<Uint8Array> = Stream.empty,
  ) {
    yield* Effect.annotateCurrentSpan({ host, operation });
    return yield* collectCommand(
      spawner,
      operation,
      command,
      args,
      {
        env: { ...clientEnvironment },
        extendEnv: false,
        stdin: input,
      },
      maxOutputBytes,
    );
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
      undefined,
      sshInput(shell, Stream.empty),
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
      context.maxOutputBytes,
      sshInput(shell, Stream.empty),
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
      stdin: sshInput(shell, Stream.make(encoder.encode(Redacted.value(input)))),
    });
    const secret = Redacted.value(input);
    const scrub = (text: string) => (secret === "" ? text : text.replaceAll(secret, "[REDACTED]"));
    return yield* requireSuccess(operation, shell.destination, shell.ssh.command, sshArgs, {
      ...result,
      stdout: scrub(result.stdout),
      stderr: scrub(result.stderr),
    });
  });

  const selectShell = Effect.fn("RemoteExecutor.sendingShell")(function* (
    worker: WorkerName,
    shell: RemoteShell,
    variables: Readonly<Record<string, Redacted.Redacted<string>>>,
    selection: "cached" | "probe" = "cached",
  ) {
    yield* Effect.annotateCurrentSpan({ worker, host: shell.destination });
    if (Object.keys(variables).length === 0) return shell;
    const connection = jsonKey([
      worker,
      shell.ssh.command,
      connectionArgs(shell.ssh.args),
      shell.destination,
    ]);
    const state = yield* Effect.sync(() => {
      const existing = transports.get(connection);
      if (existing !== undefined) return existing;
      const created = SynchronizedRef.makeUnsafe(Option.none<VariableTransport>());
      transports.set(connection, created);
      return created;
    });
    const selected = yield* SynchronizedRef.modifyEffect(state, (current) =>
      Effect.gen(function* () {
        const held = Option.getOrUndefined(current);
        const names = [...new Set([...(held?.names ?? []), ...Object.keys(variables)])];
        if (
          selection === "cached" &&
          held !== undefined &&
          (held.transport === "stdin" || names.length === held.names.length)
        )
          return [held.transport, current] as const;
        const sent = Object.fromEntries(
          names.map((name) => [name, Redacted.make("usine-preflight")]),
        );
        const probe = (transport: VariableTransport["transport"]) =>
          run("preflight", sendingShell(shell, sent, transport), "sh", [
            "-c",
            SENT_VARIABLES_SCRIPT,
            "sh",
            ...names.flatMap((name) => [name, "usine-preflight"]),
          ]);
        const dropped = yield* probe("sendenv");
        const transport = dropped.trim() === "" ? "sendenv" : "stdin";
        if (transport === "stdin") {
          const missing = yield* probe("stdin");
          if (missing.trim() !== "")
            return yield* ExecutorOperationError.make({
              operation: "preflight",
              message: `SSH worker "${worker}" cannot receive variables over stdin`,
              cause: new Error("stdin variable round trip failed"),
            });
        }
        if (!logged.has(worker)) {
          logged.add(worker);
          yield* Effect.logInfo("SSH Worker variable transport selected", { worker, transport });
        } else if (held !== undefined && held.transport !== transport)
          yield* Effect.logWarning("SSH Worker variable transport changed", { worker, transport });
        return [transport, Option.some({ transport, names })] as const;
      }),
    );
    return sendingShell(shell, variables, selected);
  });

  return {
    shellFor,
    local,
    inspect,
    run,
    runWithInput,
    sendingShell: selectShell,
  } satisfies RemoteCommands;
});
