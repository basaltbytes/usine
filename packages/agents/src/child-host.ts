import type { AgentSessionId } from "@usine/core/agent/session";
import { Schema } from "effect";

/** Children run as processes on this machine. */
export class LocalProcess extends Schema.TaggedClass<LocalProcess>("@usine/agents/LocalProcess")(
  "LocalProcess",
  {},
) {}

/** Children run on another machine, each as one SSH command whose standard streams are the child's. */
export class RemoteShell extends Schema.TaggedClass<RemoteShell>("@usine/agents/RemoteShell")(
  "RemoteShell",
  {
    /** The local SSH executable and the options placed before the destination. */
    ssh: Schema.Struct({
      command: Schema.NonEmptyString,
      args: Schema.Array(Schema.String),
    }),
    /**
     * The SSH client's own process environment: only what SSH needs to reach
     * the machine, never the orchestrator's secrets (ADR 0011). None of it
     * reaches the child.
     */
    sshEnvironment: Schema.Record(Schema.String, Schema.String),
    /** The SSH destination, passed to the client as one argument. */
    destination: Schema.NonEmptyString,
  },
) {}

/** Where an Attempt's children run, chosen by the Worker that prepared its checkout. */
export const ChildHost = Schema.Union([LocalProcess, RemoteShell]);
export type ChildHost = typeof ChildHost.Type;

/** One command for a remote shell to run. */
export interface RemoteInvocation {
  /** The directory the command starts in; the login directory when absent. */
  readonly cwd?: string;
  /** Variables exported on top of the remote shell's own environment; undefined values are skipped. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Holds the command's pid while it runs, so cleanup can stop it after its SSH client is gone. */
  readonly pidFile?: string;
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
export const remoteShellCommand = (invocation: RemoteInvocation): string => {
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

/** The SSH client's arguments that run `invocation` on the host's machine. */
export const sshArguments = (host: RemoteShell, invocation: RemoteInvocation): Array<string> => [
  ...host.ssh.args,
  host.destination,
  "--",
  remoteShellCommand(invocation),
];

/**
 * Where a remote child's pid is kept while it runs: beside its worktree,
 * named by the child's number in its session id. Worker cleanup stops every
 * `<worktree>.child-*.pid` before it removes the worktree.
 */
export const childPidFile = (worktree: string, session: AgentSessionId): string =>
  `${worktree}.child-${session.slice(session.lastIndexOf(":") + 1)}.pid`;
