import { checkpointRow } from "~/features/runs/lib/outline";
import { type Checkpoint } from "~/lib/runs/transcript/document/model";
import { cn } from "~/lib/utils";

const checkpointTone = (tone: Checkpoint["tone"]) =>
  tone === "failed"
    ? "text-destructive"
    : tone === "warning"
      ? "text-warning"
      : "text-muted-foreground aria-[current=location]:text-foreground";

type CheckpointButtonProps = {
  readonly checkpoint: Checkpoint;
  readonly current: string | null;
  /** Whether to show the speaker, for a checkpoint listed outside its session's folded turns. */
  readonly named: boolean;
  readonly onCheckpoint: (checkpoint: Checkpoint) => void;
};

export const CheckpointButton = ({
  checkpoint,
  current,
  named,
  onCheckpoint,
}: CheckpointButtonProps) => (
  <button
    type="button"
    title={checkpoint.text}
    aria-current={checkpoint.key === current ? "location" : undefined}
    onClick={() => onCheckpoint(checkpoint)}
    className={cn(checkpointRow, checkpointTone(checkpoint.tone))}
  >
    {named && checkpoint.speaker !== null && (
      <span className="shrink-0 text-sidebar-foreground">{checkpoint.speaker}</span>
    )}
    <span className="truncate">{checkpoint.label}</span>
  </button>
);
