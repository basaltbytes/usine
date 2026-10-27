import type { WorkerConfigurationView } from "@usine/orchestrator/operator";
import { StatusBadge } from "~/components/status-badge";
import { preflightSummary } from "~/features/configuration/strings";
import { dayTimeLabel } from "~/lib/strings";

const summaryBadge = {
  passed: { state: "Succeeded", label: "Passed" },
  degraded: { state: "Waiting", label: "Degraded" },
  deferred: { state: "Deferred", label: "Deferred" },
  failed: { state: "Failed", label: "Failed" },
} as const;

type PreflightStateProps = { readonly worker: WorkerConfigurationView };

export const PreflightState = ({ worker }: PreflightStateProps) => {
  const { state, checkedAt } = preflightSummary(worker);
  if (state === "unchecked") return <span className="text-muted-foreground">Not checked</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <StatusBadge {...summaryBadge[state]} />
      {checkedAt !== null && (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {dayTimeLabel(checkedAt)}
        </span>
      )}
    </span>
  );
};
