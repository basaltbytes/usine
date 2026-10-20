import type { Harness } from "@usine/core/agent/brain";
import type { AttemptView, WorkerAccess } from "@usine/orchestrator/operator";
import { Option } from "effect";
import { CodeBlock, CodeBlockHeader, CodeBlockTitle } from "@/components/ai-elements/code-block";
import { CopyButton } from "@/components/ai-elements/copy-button";
import type { TranscriptSession } from "./model.ts";

// Quote each shell argument independently, including apostrophes in worker paths.
const shellArgument = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** How each harness reopens a saved conversation by id; Pi keeps no session to resume. */
const RESUME_COMMANDS = {
  claude: Option.some("claude --resume"),
  codex: Option.some("codex resume --"),
  pi: Option.none(),
} satisfies Record<Harness, Option.Option<string>>;

/**
 * Where the operator runs `command`, a command line for the worker's machine:
 * as is for a local worker or one `usine.yaml` no longer declares, and over
 * `ssh -t` for an ssh worker. The remote shell parses `ssh`'s last argument
 * again, so the whole command is quoted once more.
 */
const fromOperatorTerminal = (access: WorkerAccess | null, command: string): string => {
  if (access === null || access._tag === "Local") return command;
  const port = access.port === null ? [] : ["-p", String(access.port)];
  return ["ssh", "-t", ...port, access.destination, shellArgument(command)].join(" ");
};

/** Reopens a saved child conversation from the operator's terminal, on the worker that ran it. */
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
  const command = fromOperatorTerminal(
    workerAccess,
    `cd -- ${shellArgument(saved.cwd)} && ${resume} ${shellArgument(saved.id)}`,
  );
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p className="wrap-anywhere">
        Session <span className="font-mono">{saved.id}</span>
      </p>
      <p className="wrap-anywhere">
        Worktree <span className="font-mono">{saved.cwd}</span>
        {workerAccess?._tag === "Ssh" && (
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
      <p>Same harness login as the attempt. The worktree is removed at attempt cleanup</p>
    </div>
  );
};
