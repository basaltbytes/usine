import type { PreflightCheckView } from "@usine/orchestrator/operator";
import { StatusBadge } from "~/components/status-badge";
import { failedCheckLabel } from "~/features/configuration/strings";

type CheckResultProps = { readonly check: PreflightCheckView };

export const CheckResult = ({ check }: CheckResultProps) => {
  switch (check._tag) {
    case "Passed":
      return <StatusBadge state="Succeeded" label="Passed" />;
    case "Degraded":
      return <StatusBadge state="Waiting" label="Degraded: no container per attempt" />;
    case "Deferred":
      return <StatusBadge state="Deferred" label="Deferred" />;
    case "Failed":
      return <StatusBadge state="Failed" label={`Failed: ${failedCheckLabel(check)}`} />;
  }
};
