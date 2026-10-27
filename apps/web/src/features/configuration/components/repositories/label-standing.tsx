import type { LabelStateView } from "@usine/orchestrator/operator";

type LabelStandingProps = { readonly label: LabelStateView };

/** Renders the problem with a label next to its chip; renders nothing if the label exists on GitHub
 * or the labels have not been polled yet. */
export const LabelStanding = ({ label }: LabelStandingProps) => {
  if (label.failure !== null)
    return <span className="text-destructive">{label.failure.message}</span>;
  if (label.onGitHub !== false) return null;
  return (
    <span className="text-destructive">
      Missing on GitHub{label.declared ? ", created at the next poll" : ""}
    </span>
  );
};
