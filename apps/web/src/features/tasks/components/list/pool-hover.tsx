import type { TaskUsageView } from "@usine/orchestrator/operator";
import { type ReactNode } from "react";
import { PoolBreakdown } from "~/components/runs/usage";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/components/ui/hover-card";

const usageTrigger =
  "relative z-10 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/70 focus-visible:outline-solid";

type PoolHoverProps = {
  readonly usage: TaskUsageView;
  readonly label: string;
  readonly note: string | null;
  readonly children: ReactNode;
};

/** Shows the Task's tokens per billing pool when `children` is hovered or focused, after `note` if set. */
export const PoolHover = ({ usage, label, note, children }: PoolHoverProps) => (
  <HoverCard>
    <HoverCardTrigger
      delay={200}
      aria-label={label}
      render={<button type="button" className={usageTrigger} />}
    >
      {children}
    </HoverCardTrigger>
    <HoverCardContent
      align="end"
      className="w-[26rem] max-w-[calc(100vw-2rem)] p-3 font-sans text-xs shadow-raised"
    >
      {note !== null && <p className="pb-2 text-muted-foreground">{note}.</p>}
      <PoolBreakdown pools={usage.pools} />
    </HoverCardContent>
  </HoverCard>
);
