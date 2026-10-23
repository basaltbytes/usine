import type { AgentSessionId } from "@usine/core/agent/session";
import { Schema } from "effect";

/** A host that runs children as local processes. */
export class LocalProcess extends Schema.TaggedClass<LocalProcess>("@usine/agents/LocalProcess")(
  "LocalProcess",
  {},
) {}

/** The local SSH executable and the options before the destination. */
export const SshCommand = Schema.Struct({
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
});
export type SshCommand = typeof SshCommand.Type;

/** A host that runs each child on another machine as one SSH command, through its standard streams. */
export class RemoteShell extends Schema.TaggedClass<RemoteShell>("@usine/agents/RemoteShell")(
  "RemoteShell",
  {
    ssh: SshCommand,
    /**
     * The SSH client's process environment: what SSH needs to connect, never the orchestrator's
     * secrets (ADR 0011), plus the variables that `-o SendEnv=` options in `ssh` forward to the
     * child. Use it for values that must not appear on the command line, such as a Gateway caller
     * token. Never log this field.
     */
    sshEnvironment: Schema.Record(Schema.String, Schema.String),
    /** The SSH destination, passed as one argument. */
    destination: Schema.NonEmptyString,
  },
) {}

/** The host that runs an Attempt's children, chosen by the Worker that prepared its checkout. */
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
  readonly command: string;
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

/** Returns the SSH client arguments that run `invocation`: the options, the destination, and one remote command line. */
export const sshArguments = (host: RemoteShell, invocation: HostInvocation): Array<string> => [
  ...host.ssh.args,
  host.destination,
  "--",
  remoteShellCommand(invocation),
];

/** Returns the PID file path of a remote child: next to its worktree, named by the child number in its session ID. */
export const childPidFile = (worktree: string, session: AgentSessionId): string =>
  `${worktree}.child-${session.slice(session.lastIndexOf(":") + 1)}.pid`;

/**
 * A shell script that stops an Attempt's remaining remote children before its worktree is kept or
 * removed: for each `<worktree>.child-*.pid`, it sends TERM, waits, then sends KILL. Run it with
 * `sh -c` and the worktree as `$1`; it prints one outcome per PID file. An exited SSH client does
 * not mean that its remote command stopped.
 */
export const CHILD_KILL_SCRIPT = `
found=0
for pidfile in "$1".child-*.pid; do
  test -f "$pidfile" || continue
  found=1
  pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null; then
    n=0
    while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 10 ]; do sleep 0.5; n=$((n+1)); done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null; echo "$pidfile killed"; else echo "$pidfile stopped"; fi
  else
    echo "$pidfile absent"
  fi
  rm -f "$pidfile"
done
test "$found" = 1 || echo no-children
`.trim();
