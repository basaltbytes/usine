import type { StalledItemView } from "@usine/orchestrator/operator";
import type { ReactNode } from "react";
import { useNow } from "~/hooks/use-now";
import { stallSentence } from "~/lib/stall/strings";
import { TextTooltip } from "~/components/text-tooltip";

type StallNoteProps = {
  readonly stalled: StalledItemView;
  readonly named: boolean;
  readonly children: ReactNode;
};

/** `named` prefixes the Loop name when neither the card's Run line nor the stall text includes it. */
export const StallNote = ({ stalled, named, children }: StallNoteProps) => {
  const now = useNow(30_000);
  const sentence = stallSentence(stalled, now);
  return (
    <div data-slot="stall-note" className="flex flex-col items-start gap-1.5 text-xs">
      <TextTooltip text={`${stalled.loop}: ${sentence}`}>
        <p className="line-clamp-3 text-muted-foreground">
          {named && <span className="font-medium text-foreground">{stalled.loop} </span>}
          {sentence}
        </p>
      </TextTooltip>
      {children}
    </div>
  );
};
