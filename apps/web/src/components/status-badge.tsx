import { cn } from "@/lib/utils";

/** Returns the tone class for a Run, Attempt, Project, Loop, or Item state (ADR 0015). An unpaused
 * Loop is `live`; an Open Item uses the default muted tone. */
const stateTone = (state: string): string => {
  switch (state) {
    case "Succeeded":
    case "Merged":
    case "clear":
    case "live":
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
    case "Closed":
    case "paused":
      return "text-run-canceled";
    default:
      return "text-muted-foreground";
  }
};

/** Renders a dot in the state's tone that pulses while the state is `Running`. */
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

/** `label` replaces the state name when the state key is not its sentence-case name. */
export const StatusBadge = ({
  state,
  label = state,
}: {
  readonly state: string;
  readonly label?: string;
}) => (
  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
    <StateMark state={state} />
    {label}
  </span>
);

export const NeedsYouBadge = () => (
  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-needs-you">
    <StateMark state="needs-you" />
    Needs attention
  </span>
);
