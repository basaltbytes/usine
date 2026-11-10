import type { AgentSessionId } from "@usine/core/agent/session";
import { type Brand, Redacted, Schema, Stream } from "effect";
import { Base64 } from "effect/encoding";

/** A host that runs children as local processes. */
export class LocalProcess extends Schema.TaggedClass<
  LocalProcess,
  Brand.Brand<"@usine/agents/child-host/child-host/LocalProcess">
>("@usine/agents/LocalProcess")("LocalProcess", {}) {}

/**
 * The local SSH executable and the options before the destination. The executable is OpenSSH's
 * `ssh`, or a stand-in program that reaches the machine another way and follows the same contract:
 *
 * - Arguments: `args`, then any `-o <option>` pairs that usine adds, such as
 *   `-o ConnectTimeout=10`, then the destination, `--`, and one command line for the machine's
 *   POSIX shell. A stand-in accepts and ignores every `-o` option. usine adds other OpenSSH options,
 *   such as `-F`, `-J`, and `-p`, only to an `ssh` that it runs.
 * - Standard streams: the program writes its stdin to the command's stdin until stdin ends, which
 *   closes the command's stdin. It writes the command's stdout and stderr to its own, byte for
 *   byte, each in order.
 * - Exit code: the command's exit code, or 255 when the program can't reach the machine, or loses
 *   the command before it exits. A command that exits 255 itself looks like a transport failure.
 * - Environment: `RemoteShell.sshEnvironment`. A stand-in reads its endpoint and credential there,
 *   and never from its arguments, which process listings show.
 */
export const SshCommand = Schema.Struct({
  /** The SSH executable on the launching machine, resolved through its PATH or an explicit path. */
  command: Schema.NonEmptyString,
  /** SSH options, or a stand-in's own arguments, before the destination, each a separate argument. */
  args: Schema.Array(Schema.String),
});
export type SshCommand = typeof SshCommand.Type;

/** A running container on the remote machine, entered with `<runtime> exec`. */
export const ShellContainer = Schema.Struct({
  /** The container CLI on the machine, such as `docker`. */
  runtime: Schema.NonEmptyString,
  /** The existing container name or ID accepted by the container CLI. */
  name: Schema.NonEmptyString,
});
export type ShellContainer = typeof ShellContainer.Type;

/** A host that runs each child on another machine as one SSH command, through its standard streams. */
export class RemoteShell extends Schema.TaggedClass<
  RemoteShell,
  Brand.Brand<"@usine/agents/child-host/child-host/RemoteShell">
>("@usine/agents/RemoteShell")("RemoteShell", {
  /** The local SSH client and connection options used to reach the remote machine. */
  ssh: SshCommand,
  /**
   * The SSH client's process environment: what SSH needs to connect, never the orchestrator's
   * secrets (ADR 0011), plus the variables that `-o SendEnv=` options in `ssh` forward to the
   * child. Use it for values that must not appear on the command line, such as a gateway caller
   * token. Never log this field.
   */
  sshEnvironment: Schema.Record(Schema.String, Schema.String),
  /** Secrets read from the first stdin line before the command starts. Never log this field. */
  stdinEnvironment: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Redacted(Schema.String)).check(
      Schema.makeFilter(
        (variables) =>
          Object.keys(variables).every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)),
        { message: "Expected shell environment variable names" },
      ),
    ),
  ),
  /**
   * The destination, passed as one argument: an SSH destination, or the name that a stand-in uses
   * for the machine.
   */
  destination: Schema.NonEmptyString,
  /**
   * The container that runs each command, with the working directory, variables, and PID file
   * inside it. If absent, the SSH user's shell runs the command.
   */
  container: Schema.optionalKey(ShellContainer),
}) {}

/** The host that runs an attempt's children, chosen by the worker that prepared its checkout. */
export const ChildHost = Schema.Union([LocalProcess, RemoteShell]);
export type ChildHost = typeof ChildHost.Type;

/** A command for a host to run. */
export interface HostInvocation {
  /** The working directory; defaults to the host user's home directory. */
  readonly cwd?: string | undefined;
  /**
   * The command's complete environment on a local host, or the variables exported on top of a remote
   * shell's environment; `undefined` values are skipped.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  /** On a remote shell, the file that contains the command's PID while it runs, so cleanup can stop it after the SSH client exits. */
  readonly pidFile?: string | undefined;
  /** The executable on the target host, resolved there rather than on the orchestrator. */
  readonly command: string;
  /** Command arguments in order; remote invocation quotes each argument for the shell. */
  readonly args: ReadonlyArray<string>;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const quoted = (words: ReadonlyArray<string>): string => words.map(quote).join(" ");

/**
 * Returns the remote POSIX shell command line for `invocation`, with every word quoted so it passes
 * through OpenSSH unchanged. Throws if a variable name is not a shell identifier.
 */
const remoteShellCommand = (invocation: HostInvocation): string => {
  const exports = Object.entries(invocation.environment ?? {}).flatMap(([name, value]) => {
    if (!VARIABLE_NAME.test(name)) throw new Error(`Cannot export ${name} in a remote shell`);
    return value === undefined ? [] : [`${name}=${quote(value)}`];
  });
  const setup = [
    ...(invocation.cwd === undefined ? [] : [`cd ${quote(invocation.cwd)}`]),
    ...(exports.length === 0 ? [] : [`export ${exports.join(" ")}`]),
  ];
  const command = [invocation.command, ...invocation.args];
  if (invocation.pidFile === undefined) return [...setup, `exec ${quoted(command)}`].join(" && ");
  // The inner shell writes its PID, then execs the command. The file exists only while the command
  // runs, so cleanup never signals a reused PID.
  const pidFile = quote(invocation.pidFile);
  const run = `sh -c 'printf %s "$$" > "$0" && exec "$@"' ${pidFile} ${quoted(command)}`;
  return `${[...setup, run].join(" && ")}; code=$?; rm -f ${pidFile}; exit "$code"`;
};

/**
 * Returns the SSH client arguments that run `invocation`: the options, the destination, and one
 * remote command line. In a container, the line runs `sh -c` with `invocation`'s command line
 * through `<runtime> exec -i`, so its standard streams pass through.
 */
export const sshArguments = (host: RemoteShell, invocation: HostInvocation): Array<string> => {
  const line =
    (host.stdinEnvironment === undefined
      ? ""
      : 'set +x; IFS= read -r usine_environment && usine_environment=$(printf %s "$usine_environment" | base64 -d) && eval "unset usine_environment; $usine_environment" && ') +
    remoteShellCommand(invocation);
  return [
    ...host.ssh.args,
    host.destination,
    "--",
    host.container === undefined
      ? line
      : `exec ${quoted([host.container.runtime, "exec", "-i", host.container.name, "sh", "-c", line])}`,
  ];
};

/** Prepends the secret environment block consumed by `sshArguments`, preserving command input. */
export const sshInput = <E, R>(host: RemoteShell, input: Stream.Stream<Uint8Array, E, R>) => {
  const variables = host.stdinEnvironment;
  if (variables === undefined) return input;
  return Stream.concat(
    Stream.suspend(() => {
      const exports = Object.entries(variables).map(
        ([name, value]) => `export ${name}=${quote(Redacted.value(value))}`,
      );
      return Stream.make(new TextEncoder().encode(`${Base64.encode(exports.join(";"))}\n`));
    }),
    input,
  );
};

/** Returns the PID file path of a remote child: next to its worktree, named by the child number in its session ID. */
export const childPidFile = (worktree: string, session: AgentSessionId): string =>
  `${worktree}.child-${session.slice(session.lastIndexOf(":") + 1)}.pid`;

/**
 * The exit code of the OpenSSH client when it can't connect, loses the connection, or can't run the
 * remote command. Any other code is the remote command's.
 */
export const SSH_FAILURE = 255;

/**
 * Stops the process in `$pidfile` (or its process group for a negative PID): TERM, up to 10 seconds of waiting, then KILL. Prints
 * `<pidfile> stopped`, `killed`, or `absent`, and removes the file.
 */
const STOP_PID_FILE = `
  pid_alive() {
    if [ -d "$pidfile.transport" ]; then
      identity=$(cat "$pidfile.transport/identity" 2>/dev/null) || return 1
      boot=$(cat /proc/sys/kernel/random/boot_id) || return 1
      start=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '$1 != "Z" {print $20}')
      test -n "$start" && test "$identity" = "$boot:$pid:$start"
    else
      kill -0 "$pid" 2>/dev/null
    fi
  }
  pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$pid" ] && pid_alive && kill -TERM "$pid" 2>/dev/null; then
    n=0
    while pid_alive && [ "$n" -lt 20 ]; do sleep 0.5; n=$((n+1)); done
    if pid_alive; then kill -KILL "$pid" 2>/dev/null; echo "$pidfile killed"; else echo "$pidfile stopped"; fi
  else
    echo "$pidfile absent"
  fi
  rm -f "$pidfile"
  rm -rf -- "$pidfile.transport"`;

/**
 * A shell script that stops an attempt's remaining remote children before its worktree is kept or
 * removed: for each `<worktree>.child-*.pid`, it sends TERM, waits, then sends KILL. Run it with
 * `sh -c` and the worktree as `$1`; it prints one outcome per PID file. An exited SSH client does
 * not mean that its remote command stopped.
 */
export const CHILD_KILL_SCRIPT = `
found=0
for pidfile in "$1".child-*.pid; do
  test -f "$pidfile" || continue
  found=1${STOP_PID_FILE}
done
for journal in "$1".child-*.pid.transport; do
  test -d "$journal" || continue
  test -f "\${journal%.transport}" || rm -rf -- "$journal"
done
test "$found" = 1 || echo no-children
`.trim();

/**
 * A shell script that stops one remote child, whose PID file (`childPidFile`) is `$1`, in the way
 * `CHILD_KILL_SCRIPT` stops each child. Run it with `sh -c`; it prints one outcome.
 */
export const CHILD_STOP_SCRIPT = `pidfile=$1${STOP_PID_FILE}`;
