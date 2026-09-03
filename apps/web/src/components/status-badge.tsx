import { CircleIcon } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Run, Attempt, and Project states share one semantic tone scale (ADR 0015). */
const tone = (state: string): string => {
  switch (state) {
    case "Succeeded":
    case "clear":
      return "text-run-succeeded";
    case "Running":
    case "Pending":
    case "Queued":
    case "active":
      return "text-run-active";
    case "Waiting":
    case "Failed":
    case "needs-you":
      return "text-needs-you";
    default:
      return "text-muted-foreground";
  }
};

export const StatusBadge = ({ state }: { readonly state: string }) => (
  <Badge variant="outline" aria-label={state} className={cn("font-mono", tone(state))}>
    <CircleIcon weight="fill" aria-hidden="true" />
    {state}
  </Badge>
);

export const NeedsYouBadge = ({ count }: { readonly count?: number }) => (
  <Badge variant="outline" className="border-needs-you/40 font-mono text-needs-you">
    {count === undefined || count === 0 ? "Needs you" : `${count} need you`}
  </Badge>
);
