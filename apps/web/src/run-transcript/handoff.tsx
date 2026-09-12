import { Option } from "effect";
import { CodeBlock, CodeBlockHeader, CodeBlockTitle } from "@/components/ai-elements/code-block";
import { CopyButton } from "@/components/ai-elements/copy-button";
import type { TranscriptSession } from "./model.ts";

// Quote each shell argument independently, including apostrophes in worker paths.
const shellArgument = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Opens a saved child conversation on the worker that created it. */
export const SessionHandoff = ({
  session,
}: {
  readonly session: Pick<TranscriptSession, "session" | "harnessSession">;
}) => {
  const harness = session.session.brain.harness;
  if (Option.isNone(session.harnessSession) || harness === "pi")
    return <p className="text-xs text-muted-foreground">No saved harness session recorded.</p>;
  const { id, cwd } = session.harnessSession.value;
  const resume = harness === "claude" ? "claude --resume" : "codex resume --";
  const command = `cd -- ${shellArgument(cwd)} && ${resume} ${shellArgument(id)}`;
  return (
    <div className="space-y-2 text-xs">
      <p className="wrap-anywhere text-muted-foreground">
        Harness session: <span className="font-mono">{id}</span>
      </p>
      <p className="wrap-anywhere text-muted-foreground">
        Worker worktree: <span className="font-mono">{cwd}</span>
      </p>
      <CodeBlock code={command} language="bash">
        <CodeBlockHeader>
          <CodeBlockTitle>Resume on worker</CodeBlockTitle>
          <CopyButton value={command} label="Copy resume command" />
        </CodeBlockHeader>
      </CodeBlock>
      <p className="text-muted-foreground">
        Run on the same worker with the same harness account. Requires its worktree and saved
        session files; Attempt cleanup removes the worktree.
      </p>
    </div>
  );
};
