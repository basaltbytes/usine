import type { AgentSessionId } from "@usine/core/agent/session";
import { Schema } from "effect";

/** Children run as processes on this machine. */
export class LocalProcess extends Schema.TaggedClass<LocalProcess>("@usine/agents/LocalProcess")(
  "LocalProcess",
  {},
) {}

/** The local SSH executable and the options placed before the destination. */
export const SshCommand = Schema.Struct({
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
});
export type SshCommand = typeof SshCommand.Type;

/** Children run on another machine, each as one SSH command whose standard streams are the child's. */
export class RemoteShell extends Schema.TaggedClass<RemoteShell>("@usine/agents/RemoteShell")(
  "RemoteShell",
  {
    ssh: SshCommand,
    /**
     * The SSH client's own process environment: what SSH needs to reach the
     * machine, never the orchestrator's secrets (ADR 0011), and the variables
     * an `-o SendEnv=` option in `ssh` names. Only those reach the child, so a
     * value that must stay out of the command line, such as a Gateway caller
     * token, travels here; never log this field.
     */
    sshEnvironment: Schema.Record(Schema.String, Schema.String),
    /** The SSH destination, passed to the client as one argument. */
    destination: Schema.NonEmptyString,
  },
) {}

/** Where an Attempt's children run, chosen by the Worker that prepared its checkout. */
export const ChildHost = Schema.Union([LocalProcess, RemoteShell]);
export type ChildHost = typeof ChildHost.Type;

/** One command for a host to run. */
export interface HostInvocation {
  /** The directory the command starts in; the host user's home directory when absent. */
  readonly cwd?: string | undefined;
  /**
   * The command's complete environment on this machine. On a remote shell,
   * the variables exported on top of the shell's own environment; undefined
   * values are skipped.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined;
  /** On a remote shell, holds the command's pid while it runs, so cleanup can stop it after its SSH client is gone. */
  readonly pidFile?: string | undefined;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const quoted = (words: ReadonlyArray<string>): string => words.map(quote).join(" ");

/**
 * The command line a remote POSIX shell runs for `invocation`, every word
 * quoted so it passes OpenSSH's remote-command boundary unchanged. A variable
 * name that is not a shell identifier is a defect, since names are not quoted.
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
  // The inner shell records its own pid, then becomes the command. The file
  // exists only while the command runs, so cleanup never signals a reused pid.
  const pidFile = quote(invocation.pidFile);
  const run = `sh -c 'printf %s "$$" > "$0" && exec "$@"' ${pidFile} ${quoted(command)}`;
  return `${[...setup, run].join(" && ")}; code=$?; rm -f ${pidFile}; exit "$code"`;
};

/** The SSH client's arguments that run `invocation` on the host's machine: its options, the destination, and one remote command line. */
export const sshArguments = (host: RemoteShell, invocation: HostInvocation): Array<string> => [
  ...host.ssh.args,
  host.destination,
  "--",
  remoteShellCommand(invocation),
];

/**
 * Where a remote child's pid is kept while it runs: beside its worktree,
 * named by the child's number in its session id.
 */
export const childPidFile = (worktree: string, session: AgentSessionId): string =>
  `${worktree}.child-${session.slice(session.lastIndexOf(":") + 1)}.pid`;

/**
 * Stops every child an Attempt still runs on a remote host before its
 * worktree is kept or removed: for each `<worktree>.child-*.pid` that
 * `childPidFile` names, TERM, a bounded wait, then KILL. Run it with `sh -c`
 * and the worktree as `$1`; stdout reports one outcome per pid file. An SSH
 * client that exits does not prove its remote command has stopped.
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
