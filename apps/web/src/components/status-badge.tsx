import { UsineMark } from "~/components/usine-mark";
import { cn } from "~/lib/utils";

/** Returns the tone class for a Run, Attempt, Project, or Loop state (ADR 0015). An unpaused Loop
 * is `live`. Issue and pull request states use `ItemMark`. */
const stateTone = (state: string): string => {
  switch (state) {
    case "Succeeded":
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
    case "paused":
      return "text-run-canceled";
    default:
      return "text-muted-foreground";
  }
};

type StateMarkProps = {
  readonly state: string;
  readonly className?: string;
};

/**
 * Renders a 6px dot in the state's tone. While the state is `Running`, the 12px running mark takes
 * the dot's place, centered on it, so a row keeps its alignment.
 */
export const StateMark = ({ state, className }: StateMarkProps) =>
  state === "Running" ? (
    <span
      data-slot="state-mark"
      aria-hidden="true"
      className={cn("relative inline-block size-1.5 shrink-0", stateTone(state), className)}
    >
      <UsineMark running className="absolute top-1/2 left-1/2 size-3 -translate-1/2" />
    </span>
  ) : (
    <span
      data-slot="state-mark"
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full bg-current",
        stateTone(state),
        className,
      )}
    />
  );

type StatusBadgeProps = {
  readonly state: string;
  readonly label?: string;
};

/** `label` replaces the state name when the state key is not its sentence-case name. */
export const StatusBadge = ({ state, label = state }: StatusBadgeProps) => (
  <span className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
    <StateMark state={state} />
    {label}
  </span>
);

export const NeedsYouBadge = () => (
  <span className="inline-flex items-center gap-2 text-xs font-medium text-needs-you">
    <StateMark state="needs-you" />
    Needs attention
  </span>
);
