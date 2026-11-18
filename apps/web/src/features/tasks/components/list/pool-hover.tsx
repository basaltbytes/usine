import { Button } from "~/components/ui/button";
import type { TaskUsageView } from "@usine/orchestrator/operator";
import { type ReactNode } from "react";
import { PoolBreakdown } from "~/components/runs/usage";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/components/ui/hover-card";

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
      render={<Button variant="text-link" size="text" className="relative z-10" />}
    >
      {children}
    </HoverCardTrigger>
    <HoverCardContent variant="detail" align="end" className="w-[26rem] max-w-[calc(100vw-2rem)]">
      {note !== null && <p className="pb-2 text-muted-foreground">{note}.</p>}
      <PoolBreakdown pools={usage.pools} />
    </HoverCardContent>
  </HoverCard>
);
