import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import type { LoopFileView } from "@usine/orchestrator/operator";
import { Button } from "~/components/ui/button";
import { type PauseLoop } from "~/features/configuration/components/loops/list";

type PauseButtonProps = {
  readonly loop: LoopFileView;
  readonly pause: PauseLoop;
  readonly variant: "ghost" | "outline";
};

/** Renders nothing when operator actions are unavailable, as in setup mode. */
export const PauseButton = ({ loop, pause, variant }: PauseButtonProps) => {
  const sending = pause.isPending && pause.variables.loop === loop.name;
  return (
    <Button
      variant={variant}
      disabled={pause.isPending}
      className={variant === "ghost" ? "text-muted-foreground" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        pause.mutate({ loop: loop.name, paused: loop.paused });
      }}
    >
      {loop.paused ? (
        <PlayIcon data-icon="inline-start" aria-hidden="true" />
      ) : (
        <PauseIcon data-icon="inline-start" aria-hidden="true" />
      )}
      <span className={variant === "ghost" ? "max-sm:sr-only" : undefined}>
        {sending ? (loop.paused ? "Resuming…" : "Pausing…") : loop.paused ? "Resume" : "Pause"}
      </span>
      {variant === "ghost" && <span className="sr-only"> {loop.name}</span>}
    </Button>
  );
};
