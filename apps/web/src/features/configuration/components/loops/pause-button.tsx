import { useState } from "react";
import { ResumeLoop } from "./resume";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import type { LoopFileView } from "@usine/orchestrator/operator";
import { CommandButton } from "~/components/command-palette/button";
import { type PauseLoop } from "~/features/configuration/components/loops/list";

type PauseButtonProps = {
  readonly loop: LoopFileView;
  readonly pause: PauseLoop;
  readonly variant: "ghost" | "outline";
};

/** Renders nothing when operator actions are unavailable, as in setup mode. */
export const PauseButton = ({ loop, pause, variant }: PauseButtonProps) => {
  const [resuming, setResuming] = useState(false);
  const sending = pause.isPending && pause.variables.loop === loop.name;
  return (
    <>
      <CommandButton
        command={`${loop.paused ? "Resume" : "Pause"} ${loop.name}`}
        variant={variant}
        disabled={pause.isPending}
        className={variant === "ghost" ? "text-muted-foreground" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (loop.paused) setResuming(true);
          else pause.mutate({ loop: loop.name, paused: false });
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
      </CommandButton>
      {resuming && <ResumeLoop name={loop.name} pause={pause} close={() => setResuming(false)} />}
    </>
  );
};
