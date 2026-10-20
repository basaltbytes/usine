import type { Harness } from "@usine/core/agent/brain";
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

/** Opens a saved child conversation on the worker that created it. */
export const SessionHandoff = ({
  session,
}: {
  readonly session: Pick<TranscriptSession, "session" | "harnessSession">;
}) => {
  const handoff = Option.all({
    resume: RESUME_COMMANDS[session.session.brain.harness],
    saved: session.harnessSession,
  });
  if (Option.isNone(handoff))
    return <p className="text-xs text-muted-foreground">No saved harness session</p>;
  const { resume, saved } = handoff.value;
  const command = `cd -- ${shellArgument(saved.cwd)} && ${resume} ${shellArgument(saved.id)}`;
  return (
    <div className="space-y-2 text-xs">
      <p className="wrap-anywhere text-muted-foreground">
        Harness session: <span className="font-mono">{saved.id}</span>
      </p>
      <p className="wrap-anywhere text-muted-foreground">
        Worker worktree: <span className="font-mono">{saved.cwd}</span>
      </p>
      <CodeBlock code={command} language="bash">
        <CodeBlockHeader>
          <CodeBlockTitle>Resume on worker</CodeBlockTitle>
          <CopyButton value={command} label="Copy resume command" />
        </CodeBlockHeader>
      </CodeBlock>
      <p className="text-muted-foreground">
        Run on the same worker with the same harness account. Needs the worktree and the saved
        session files; attempt cleanup removes the worktree.
      </p>
    </div>
  );
};
