import { cn } from "@/lib/utils";

/** Run, Attempt, and Project states share one semantic tone scale (ADR 0015). */
const stateTone = (state: string): string => {
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
      return "text-run-waiting";
    case "needs-you":
      return "text-needs-you";
    case "Failed":
      return "text-run-failed";
    case "Canceled":
      return "text-run-canceled";
    default:
      return "text-muted-foreground";
  }
};

/** A dot in the state's tone; it pulses while the state is `Running`. The state's word sits beside it. */
export const StateMark = ({
  state,
  className,
}: {
  readonly state: string;
  readonly className?: string;
}) => (
  <span
    data-slot="state-mark"
    aria-hidden="true"
    className={cn(
      "inline-block size-1.5 shrink-0 rounded-full bg-current",
      stateTone(state),
      state === "Running" && "animate-pulse motion-reduce:animate-none",
      className,
    )}
  />
);

export const StatusBadge = ({ state }: { readonly state: string }) => (
  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
    <StateMark state={state} />
    {state}
  </span>
);

export const NeedsYouBadge = ({ count }: { readonly count?: number }) => (
  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-needs-you tabular-nums">
    <StateMark state="needs-you" />
    {count === undefined || count === 0 ? "Needs you" : `${count} need you`}
  </span>
);
