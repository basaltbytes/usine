import type { Harness } from "@usine/core/agent/brain";
import type { AttemptView, WorkerAccess } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { CodeBlock, CodeBlockHeader, CodeBlockTitle } from "@/components/ai-elements/code-block";
import { CopyButton } from "@/components/ai-elements/copy-button";
import { providerLabel } from "../operator-copy.ts";
import type { TranscriptSession } from "./model.ts";

// Returns the value single-quoted for a POSIX shell, with apostrophes escaped.
const shellArgument = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

interface ResumeCommand {
  readonly command: string;
  /** The variable that points the harness at a saved session's `home`. */
  readonly homeVariable: Option.Option<string>;
}

/** The resume command per harness; `None` for Pi, which has no resumable session. */
const RESUME_COMMANDS = {
  claude: Option.some({ command: "claude --resume", homeVariable: Option.none() }),
  codex: Option.some({ command: "codex resume --", homeVariable: Option.some("CODEX_HOME") }),
  pi: Option.none(),
} satisfies Record<Harness, Option.Option<ResumeCommand>>;

/**
 * Returns `command` for the operator's terminal: unchanged for a local, provisioned, or undeclared
 * Worker, or quoted again and wrapped in `ssh -t` for an SSH Worker with a destination.
 */
const fromOperatorTerminal = (access: WorkerAccess | null, command: string): string => {
  if (access === null || access._tag !== "Ssh") return command;
  const port = access.port === null ? [] : ["-p", String(access.port)];
  return ["ssh", "-t", ...port, access.destination, shellArgument(command)].join(" ");
};

/** Renders the command that resumes a child session from the operator's terminal on its Worker. */
export const SessionHandoff = ({
  session,
  attempt,
}: {
  readonly session: Pick<TranscriptSession, "session" | "harnessSession">;
  readonly attempt: Pick<AttemptView, "worker" | "workerAccess">;
}) => {
  const handoff = Option.all({
    resume: RESUME_COMMANDS[session.session.brain.harness],
    saved: session.harnessSession,
  });
  if (Option.isNone(handoff))
    return <p className="text-xs text-muted-foreground">No saved harness session</p>;
  const { resume, saved } = handoff.value;
  const { worker, workerAccess } = attempt;
  const gatewayCredential =
    session.session._tag === "ChildSession" && Option.isSome(session.session.gatewayCredential);
  if (workerAccess?._tag === "Sandbox")
    return (
      <p className="text-xs text-muted-foreground">
        Session <span className="font-mono">{saved.id}</span> ran in a Cloudflare sandbox, which
        accepts no terminal and is destroyed at attempt cleanup
      </p>
    );
  const home = Option.match(Option.all([resume.homeVariable, saved.home]), {
    onNone: () => "",
    onSome: ([variable, directory]) => `${variable}=${shellArgument(directory)} `,
  });
  const command = fromOperatorTerminal(
    workerAccess,
    `cd -- ${shellArgument(saved.cwd)} && ${home}${resume.command} ${shellArgument(saved.id)}`,
  );
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p className="wrap-anywhere">
        Session <span className="font-mono">{saved.id}</span>
      </p>
      <p className="wrap-anywhere">
        Worktree <span className="font-mono">{saved.cwd}</span>
        {(workerAccess?._tag === "Ssh" || workerAccess?._tag === "Provisioned") && (
          <>
            {" on "}
            <span className="font-mono">{worker}</span>
          </>
        )}
      </p>
      {workerAccess === null && (
        <p className="wrap-anywhere">
          Worker <span className="font-mono">{worker}</span> is no longer declared in usine.yaml
        </p>
      )}
      <CodeBlock code={command} language="bash" wrap>
        <CodeBlockHeader>
          <CodeBlockTitle>Resume this session</CodeBlockTitle>
          <CopyButton value={command} label="Copy command" />
        </CodeBlockHeader>
      </CodeBlock>
      {workerAccess?._tag === "Provisioned" ? (
        <>
          <p>{`Run it on the attempt's ${providerLabel[workerAccess.provider]} machine, which is deleted with the attempt`}</p>
          {/* A provisioned machine's child used its gateway's credential or the provisioner's API key. */}
          {gatewayCredential && (
            <p>The gateway credential or API key isn't available from your shell</p>
          )}
        </>
      ) : gatewayCredential ? (
        <p>
          The gateway credential isn't available from your shell. The worktree is removed at attempt
          cleanup
        </p>
      ) : (
        <p>Same harness login as the attempt. The worktree is removed at attempt cleanup</p>
      )}
    </div>
  );
};
